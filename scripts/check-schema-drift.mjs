#!/usr/bin/env node
/**
 * check-schema-drift.mjs — proves prisma/schema.prisma is an exact mirror of
 * prisma/migrations/0001_init/migration.sql, with ZERO drift.
 *
 * The SQL migration is the only DDL authority in this repo (see the header of
 * schema.prisma and docs/decisiones.md). Prisma 6 cannot express ltree, GiST,
 * GIN, partial or EXCLUDE indexes, so a hand-written checker is the only way
 * to keep the two files honest as the schema grows in F2–F8.
 *
 * What it compares:
 *   1. enums         — same type names, same values, same order
 *   2. tables        — same table names
 *   3. columns       — same names, same normalised SQL type, same nullability
 *   4. primary keys  — same single-column and composite keys
 *   5. indexes, both directions
 *        every @@index / @@unique / @@id declared in schema.prisma must exist
 *          in the SQL under the exact same name, table, kind and columns;
 *        every NAMED index in the SQL must either be declared in
 *          schema.prisma or be listed in its "Indexes NOT redeclared here"
 *          comment block, so SQL-only objects cannot be forgotten silently.
 *
 * Exit code: 0 = zero drift, 1 = drift found (printed item by item).
 * Usage: pnpm db:check:drift
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SQL_PATH = join(ROOT, "prisma", "migrations", "0001_init", "migration.sql");
const SCHEMA_PATH = join(ROOT, "prisma", "schema.prisma");

// --- SQL type -> canonical token --------------------------------------------
// `int4`/`int8` are the internal Postgres names of INTEGER/BIGINT; normalising
// them lets the comparison ignore cosmetic differences only. A bare TIMESTAMPTZ
// means precision 6 in Postgres, so it normalises to `timestamptz(6)`.
const SQL_TYPE_TOKENS = {
  UUID: "uuid",
  TEXT: "text",
  CITEXT: "citext",
  LTREE: "ltree",
  TIMESTAMPTZ: "timestamptz(6)",
  TIMESTAMP: "timestamp(6)",
  DATE: "date",
  JSONB: "jsonb",
  JSON: "json",
  BOOLEAN: "boolean",
  INTEGER: "int4",
  INT: "int4",
  BIGINT: "int8",
  SMALLINT: "int2",
  NUMERIC: "numeric",
  DECIMAL: "numeric",
  REAL: "float4",
  "DOUBLE PRECISION": "float8",
};

const PRISMA_NATIVE_TOKENS = {
  Uuid: "uuid",
  Text: "text",
  Citext: "citext",
  Ltree: "ltree",
  Timestamptz: "timestamptz",
  Timestamp: "timestamp",
  Date: "date",
  JsonB: "jsonb",
  Json: "json",
  BigInt: "int8",
  Integer: "int4",
  Boolean: "boolean",
  Decimal: "numeric",
  Float: "float8",
};

const ENUM_TYPE_RE = /CREATE TYPE\s+(\w+)\s+AS ENUM\s*\(([\s\S]*?)\)\s*;/g;
const CREATE_TABLE_RE = /CREATE TABLE\s+(\w+)\s*\(([\s\S]*?)\n\);/g;
const CREATE_INDEX_RE =
  /CREATE\s+(UNIQUE\s+)?INDEX\s+(\w+)\s+ON\s+(\w+)\s*(?:USING\s+\w+\s*)?\(([^)]*)\)([\s\S]*?);/g;

// --- generic helpers --------------------------------------------------------

/** Split a top-level comma list, ignoring commas nested in parens or quotes. */
function splitTopLevel(body) {
  const parts = [];
  let depth = 0;
  let quoted = false;
  let current = "";
  for (const ch of body) {
    if (ch === "'") quoted = !quoted;
    if (!quoted) {
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      else if (ch === "," && depth === 0) {
        parts.push(current);
        current = "";
        continue;
      }
    }
    current += ch;
  }
  if (current.trim()) parts.push(current);
  return parts.map((p) => p.trim()).filter(Boolean);
}

function stripQuotes(value) {
  return value.trim().replace(/"/g, "");
}

/** Extract `{ keyword, name, body }` blocks with real brace matching. */
function extractBlocks(src, keyword) {
  const blocks = [];
  const opener = new RegExp(`\\b${keyword}\\s+(\\w+)\\s*\\{`, "g");
  for (const match of src.matchAll(opener)) {
    let depth = 0;
    let quoted = false;
    let i = match.index + match[0].length - 1;
    const start = i + 1;
    for (; i < src.length; i++) {
      const ch = src[i];
      if (ch === '"') quoted = !quoted;
      if (quoted) continue;
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    blocks.push({ name: match[1], body: src.slice(start, i) });
  }
  return blocks;
}

// --- SQL side ---------------------------------------------------------------

function normaliseSqlType(raw) {
  const type = raw.trim().toUpperCase().replace(/\s+/g, " ");
  const args = type.match(/^(\w+(?: \w+)?)\s*\(([^)]*)\)/);
  if (args) {
    const base = args[1];
    const params = args[2].split(",").map((p) => p.trim()).filter(Boolean).join(",");
    if (base === "TIMESTAMPTZ") return `timestamptz(${params || "6"})`;
    if (base === "TIMESTAMP") return `timestamp(${params || "6"})`;
    if (base === "NUMERIC" || base === "DECIMAL") return `numeric(${params})`;
    if (base === "DOUBLE PRECISION") return "float8";
    return `${base.toLowerCase()}(${params})`;
  }
  if (SQL_TYPE_TOKENS[type]) return SQL_TYPE_TOKENS[type];
  // Anything else must be one of the enum types this migration creates.
  return `enum:${type.toLowerCase()}`;
}

function parseSql(sqlRaw) {
  const noComments = sqlRaw.replace(/--[^\n]*/g, "");

  // Enums live inside `DO $$ ... $$` blocks, so read them before stripping.
  const enums = new Map();
  for (const match of noComments.matchAll(ENUM_TYPE_RE)) {
    enums.set(match[1].toLowerCase(), [...match[2].matchAll(/'([^']+)'/g)].map((v) => v[1]));
  }

  const ddl = noComments.replace(/\$\$[\s\S]*?\$\$/g, " $$ ");
  const tables = new Map();
  const indexes = new Map();

  for (const match of ddl.matchAll(CREATE_TABLE_RE)) {
    const table = match[1].toLowerCase();
    const columns = new Map();
    let primaryKey = null;

    for (const def of splitTopLevel(match[2])) {
      const pk = def.match(/^CONSTRAINT\s+(\w+)\s+PRIMARY KEY\s*\(([^)]*)\)/i);
      if (pk) {
        primaryKey = pk[2].split(",").map((c) => stripQuotes(c));
        indexes.set(pk[1].toLowerCase(), {
          table,
          columns: primaryKey,
          kind: "primary key",
          partial: false,
        });
        continue;
      }
      const uq = def.match(/^CONSTRAINT\s+(\w+)\s+UNIQUE\s*\(([^)]*)\)/i);
      if (uq) {
        indexes.set(uq[1].toLowerCase(), {
          table,
          columns: uq[2].split(",").map((c) => stripQuotes(c)),
          kind: "unique",
          partial: false,
        });
        continue;
      }
      const ex = def.match(/^CONSTRAINT\s+(\w+)\s+EXCLUDE\b/i);
      if (ex) {
        indexes.set(ex[1].toLowerCase(), { table, columns: [], kind: "exclude", partial: false });
        continue;
      }
      if (/^(PRIMARY KEY|UNIQUE|CHECK|FOREIGN KEY|CONSTRAINT|EXCLUDE|LIKE)\b/i.test(def)) continue;

      const col = def.match(/^"?(\w+)"?\s+([A-Za-z_][\w]*)\s*(\([^)]*\))?/);
      if (!col) continue;
      const name = stripQuotes(col[1]).toLowerCase();
      const rest = def.slice(col[0].length);
      const isPrimary = /\bPRIMARY KEY\b/i.test(rest);
      columns.set(name, {
        type: normaliseSqlType(`${col[2]}${col[3] ? col[3].replace(/\s+/g, "") : ""}`),
        // Postgres makes PRIMARY KEY columns NOT NULL implicitly.
        notNull: isPrimary || /\bNOT NULL\b/i.test(rest),
      });
      if (isPrimary && !primaryKey) primaryKey = [name];
    }

    tables.set(table, { columns, primaryKey });
  }

  for (const match of ddl.matchAll(CREATE_INDEX_RE)) {
    const [, unique, name, table, cols, tail] = match;
    indexes.set(name.toLowerCase(), {
      table: table.toLowerCase(),
      columns: cols
        .split(",")
        .map((c) => stripQuotes(c.replace(/\s+(ASC|DESC)\s*/gi, " ")))
        .filter(Boolean),
      kind: unique ? "unique" : "index",
      partial: /\bWHERE\b/i.test(tail),
    });
  }

  return { enums, tables, indexes };
}

// --- schema.prisma side -----------------------------------------------------

/** Scalar field name, optional flag, column name and canonical type token. */
function parseField(line) {
  const head = line.match(/^\w+\s+([A-Za-z]\w*)\s*(.*)$/);
  if (!head) return null;
  const [, typeName, attrs] = head;
  if (/@relation\b/.test(line) || /^\s*\[\]/.test(attrs)) return null; // relation list or relation field

  const fieldName = line.split(/\s+/)[0];
  // `?` sits on the type token: `String?`, `user_role?` or `Unsupported("x")?`
  const optional = /^\w+\s+[\w"()]*\?(\s|$)/.test(line);
  const map = line.match(/@map\("([^"]+)"\)/);
  const column = (map ? map[1] : fieldName).toLowerCase();

  const unsupported = line.match(/Unsupported\("([^"]+)"\)/);
  if (unsupported) return { field: fieldName, column, optional, token: unsupported[1].toLowerCase() };

  const native = line.match(/@db\.(\w+(?:\([^)]*\))?)/);
  if (native) return { field: fieldName, column, optional, token: prismaNativeToken(native[1]) };

  const primitives = { String: "text", Int: "int4", BigInt: "int8", Boolean: "boolean", Float: "float8" };
  if (primitives[typeName]) return { field: fieldName, column, optional, token: primitives[typeName] };
  if (typeName === "DateTime") return { field: fieldName, column, optional, token: "timestamptz(6)" };
  if (typeName === "Decimal") return { field: fieldName, column, optional, token: "numeric" };
  if (typeName === "Json") return { field: fieldName, column, optional, token: "jsonb" };
  return { field: fieldName, column, optional, token: `enum:${typeName.toLowerCase()}` };
}

function prismaNativeToken(dbType) {
  const args = dbType.match(/^(\w+)\(([^)]*)\)$/);
  const baseName = args ? args[1] : dbType;
  const base = PRISMA_NATIVE_TOKENS[baseName] ?? baseName.toLowerCase();
  if (!args) return base;
  const params = args[2].split(",").map((p) => p.trim()).filter(Boolean).join(",");
  return `${base}(${params})`;
}

function parseSchema(schemaRaw) {
  const src = schemaRaw.replace(/\/\/[^\n]*/g, "");
  const enums = new Map();
  for (const block of extractBlocks(src, "enum")) {
    enums.set(block.name.toLowerCase(), block.body.split("\n").map((v) => v.trim()).filter(Boolean));
  }

  const models = new Map();
  const declaredIndexes = new Map();

  for (const block of extractBlocks(src, "model")) {
    const mapAttr = block.body.match(/@@map\("([^"]+)"\)/);
    const table = (mapAttr ? mapAttr[1] : block.name).toLowerCase();

    const fields = new Map();
    for (const line of block.body.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("@@")) continue;
      const field = parseField(trimmed);
      if (field) fields.set(field.field.toLowerCase(), field);
    }

    const columnOf = (fieldName) => fields.get(fieldName.toLowerCase())?.column ?? fieldName.toLowerCase();
    const columns = new Map();
    for (const field of fields.values()) {
      columns.set(field.column, { token: field.token, optional: field.optional, primaryKey: false });
    }

    for (const line of block.body.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("@@") && /(^|\s)@id\b/.test(trimmed)) {
        const field = parseField(trimmed);
        if (field && columns.has(field.column)) columns.get(field.column).primaryKey = true;
      }
      const composite = trimmed.match(/@@(id|unique|index)\(\[([^\]]*)\](?:\s*,\s*map:\s*"([^"]+)")?\s*\)?/);
      if (!composite) continue;
      const [, attribute, list, name] = composite;
      const listColumns = list.split(",").map((c) => columnOf(c.trim().match(/^\w+/)[0]));
      if (attribute === "id") {
        listColumns.forEach((c) => columns.get(c) && (columns.get(c).primaryKey = true));
        if (name) {
          declaredIndexes.set(name.toLowerCase(), { table, columns: listColumns, kind: "primary key" });
        }
      } else if (name) {
        declaredIndexes.set(name.toLowerCase(), {
          table,
          columns: listColumns,
          kind: attribute === "unique" ? "unique" : "index",
        });
      }
    }

    models.set(table, { model: block.name, columns });
  }

  return { enums, models, declaredIndexes };
}

/** Index names the schema header explicitly marks as SQL-only. */
function declaredSqlOnlyIndexes(schemaRaw) {
  const header = schemaRaw.slice(0, schemaRaw.indexOf("generator client"));
  const block = header.slice(header.indexOf("Indexes NOT redeclared here"));
  const names = new Set();
  for (const line of block.split("\n")) {
    const row = line.match(/^\/\/\s{2,}([a-z][a-z0-9_]*)\s{2,}\S/);
    if (row) names.add(row[1]);
  }
  return names;
}

// --- comparison -------------------------------------------------------------

function compare(sql, schema, sqlOnly) {
  const drift = [];

  // 1. enums
  for (const [name, values] of sql.enums) {
    if (!schema.enums.has(name)) {
      drift.push(`enum ${name}: created by the migration but missing in schema.prisma`);
      continue;
    }
    const prismaValues = schema.enums.get(name);
    if (prismaValues.join("|") !== values.join("|")) {
      drift.push(`enum ${name}: values differ (sql=${values.join("|")} prisma=${prismaValues.join("|")})`);
    }
  }
  for (const name of schema.enums.keys()) {
    if (!sql.enums.has(name)) {
      drift.push(`enum ${name}: declared in schema.prisma but never created by the migration`);
    }
  }

  // 2. tables, 3. columns, 4. primary keys
  for (const [table, sqlTable] of sql.tables) {
    const model = schema.models.get(table);
    if (!model) {
      drift.push(`table ${table}: created by the migration but missing in schema.prisma`);
      continue;
    }
    for (const [column, sqlColumn] of sqlTable.columns) {
      const prismaColumn = model.columns.get(column);
      if (!prismaColumn) {
        drift.push(`table ${table} column ${column}: created by the migration but missing in schema.prisma`);
        continue;
      }
      if (prismaColumn.token !== sqlColumn.type) {
        drift.push(
          `table ${table} column ${column}: type differs (sql=${sqlColumn.type} prisma=${prismaColumn.token})`,
        );
      }
      if (prismaColumn.optional === sqlColumn.notNull) {
        drift.push(
          `table ${table} column ${column}: nullability differs (sql=${
            sqlColumn.notNull ? "NOT NULL" : "NULL"
          }, prisma=${prismaColumn.optional ? "optional" : "required"})`,
        );
      }
    }
    for (const column of model.columns.keys()) {
      if (!sqlTable.columns.has(column)) {
        drift.push(`table ${table} column ${column}: declared in schema.prisma but not created by the migration`);
      }
    }

    const sqlPk = (sqlTable.primaryKey ?? []).slice().sort().join("+");
    const prismaPk = [...model.columns.entries()]
      .filter(([, c]) => c.primaryKey)
      .map(([name]) => name)
      .sort()
      .join("+");
    if (sqlPk !== prismaPk) {
      drift.push(`table ${table}: primary key differs (sql=${sqlPk || "none"} prisma=${prismaPk || "none"})`);
    }
  }
  for (const table of schema.models.keys()) {
    if (!sql.tables.has(table)) {
      drift.push(`table ${table}: declared in schema.prisma but not created by the migration`);
    }
  }

  // 5. indexes, both directions
  for (const [name, declared] of schema.declaredIndexes) {
    const sqlIndex = sql.indexes.get(name);
    if (!sqlIndex) {
      drift.push(
        `index ${name}: declared in schema.prisma on ${declared.table} but the migration never creates it`,
      );
      continue;
    }
    if (sqlIndex.table !== declared.table) {
      drift.push(`index ${name}: table differs (sql=${sqlIndex.table} prisma=${declared.table})`);
    }
    if (sqlIndex.kind !== declared.kind) {
      drift.push(`index ${name}: kind differs (sql=${sqlIndex.kind} prisma=${declared.kind})`);
    }
    if (sqlIndex.columns.join("+") !== declared.columns.join("+")) {
      drift.push(
        `index ${name}: columns differ (sql=${sqlIndex.columns.join("+")} prisma=${declared.columns.join("+")})`,
      );
    }
  }
  for (const [name, sqlIndex] of sql.indexes) {
    if (schema.declaredIndexes.has(name) || sqlOnly.has(name)) continue;
    drift.push(
      `index ${name} (${sqlIndex.kind}${sqlIndex.partial ? ", partial" : ""} on ${sqlIndex.table}): created by the migration but neither declared in schema.prisma nor listed in its "Indexes NOT redeclared here" block`,
    );
  }

  return drift;
}

// --- report -----------------------------------------------------------------

const sql = parseSql(readFileSync(SQL_PATH, "utf8"));
const schemaRaw = readFileSync(SCHEMA_PATH, "utf8");
const schema = parseSchema(schemaRaw);
const drift = compare(sql, schema, declaredSqlOnlyIndexes(schemaRaw));

const sqlColumns = [...sql.tables.values()].reduce((acc, t) => acc + t.columns.size, 0);
const prismaColumns = [...schema.models.values()].reduce((acc, m) => acc + m.columns.size, 0);
const sqlOnly = declaredSqlOnlyIndexes(schemaRaw);

console.log("red-referidos — schema.prisma vs 0001_init/migration.sql");
console.log(`  enums    ${sql.enums.size} sql / ${schema.enums.size} prisma`);
console.log(`  tables   ${sql.tables.size} sql / ${schema.models.size} prisma`);
console.log(`  columns  ${sqlColumns} sql / ${prismaColumns} prisma`);
console.log(
  `  indexes  ${sql.indexes.size} sql (${sqlOnly.size} documented as SQL-only) / ${schema.declaredIndexes.size} declared in prisma`,
);

if (drift.length === 0) {
  console.log("\nZERO DRIFT: prisma/schema.prisma mirrors 0001_init/migration.sql exactly.");
  process.exit(0);
}

console.log(`\n${drift.length} DRIFT ITEM(S):`);
for (const item of drift) console.log(`  - ${item}`);
process.exit(1);
