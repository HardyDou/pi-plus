import { parseYaml } from "./yaml.js";

/**
 * What changed between two versions of the config file.
 *
 * The audit trail answers "who did what"; this answers "what exactly". Without
 * it the answer to "who marked p201 guarded yesterday" is "somebody", and the
 * only witness is git — which the config file may not even be in.
 */

const sections = ["sessions", "nodes"];

function entries(doc, key) {
  const list = Array.isArray(doc?.[key]) ? doc[key] : [];
  const map = new Map();
  for (const entry of list) {
    const name = typeof entry?.name === "string" ? entry.name : null;
    if (name) map.set(name, entry);
  }
  return map;
}

const show = (value) => {
  if (value === undefined) return "(absent)";
  if (value === null) return "(null)";
  if (typeof value === "string") return value === "" ? '""' : value;
  return JSON.stringify(value);
};

function fieldsOf(entry) {
  const flat = new Map();
  for (const [key, value] of Object.entries(entry ?? {})) {
    if (key === "name") continue;
    // a nested map (env, defaults) is one value: "changed" is enough detail
    flat.set(key, typeof value === "object" && value !== null ? JSON.stringify(value) : value);
  }
  return flat;
}

/**
 * @returns {{ total: number, lines: string[] }} — `total` counts every change,
 *   `lines` is the human-readable head of the list.
 */
export function configChanges(before, after, { limit = 6 } = {}) {
  let was = null;
  let now = null;
  try {
    was = parseYaml(before ?? "");
  } catch {
    was = null;
  }
  try {
    now = parseYaml(after ?? "");
  } catch {
    now = null;
  }
  if (!was || !now) return { total: 0, lines: [] };

  const lines = [];
  let total = 0;
  for (const key of sections) {
    const oldMap = entries(was, key);
    const newMap = entries(now, key);
    for (const [name, entry] of newMap) {
      if (!oldMap.has(name)) {
        total += 1;
        lines.push(`+${key}.${name}`);
        continue;
      }
      const oldFields = fieldsOf(oldMap.get(name));
      const newFields = fieldsOf(entry);
      for (const [field, value] of newFields) {
        const previous = oldFields.get(field);
        if (previous !== value) {
          total += 1;
          lines.push(`${key}.${name} ${field}: ${show(previous)} -> ${show(value)}`);
        }
      }
      for (const field of oldFields.keys()) {
        if (!newFields.has(field)) {
          total += 1;
          lines.push(`${key}.${name} ${field}: ${show(oldFields.get(field))} -> (removed)`);
        }
      }
    }
    for (const name of oldMap.keys()) {
      if (!newMap.has(name)) {
        total += 1;
        lines.push(`-${key}.${name}`);
      }
    }
  }
  return { total, lines: lines.slice(0, limit) };
}
