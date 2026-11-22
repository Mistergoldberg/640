import type { Catalog } from "../types";

const SHA256 = /^[0-9a-f]{64}$/;
const YEAR = /^\d{4}$/;
const PHOTO_ID = /^(\d{4})-[0-9a-f]{14}$/;

export interface PhotoAliasTarget {
  year: string;
  photoId: string;
}

export interface PhotoAliasMap {
  schemaVersion: 1;
  status: "approved";
  packageId: string;
  packageClosedWorldSha256: string;
  transitionLedgerSha256: string;
  aliases: ReadonlyMap<string, PhotoAliasTarget>;
  retired: ReadonlySet<string>;
}

export type PhotoAliasResolution =
  | { status: "unchanged" }
  | { status: "alias"; year: string; photoId: string }
  | { status: "retired" };

function fail(message: string): never {
  throw new Error(`Invalid photo alias map: ${message}`);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${label} has unexpected fields`);
  }
}

function checkedYear(value: unknown, label: string) {
  if (typeof value !== "string" || !YEAR.test(value)) fail(`${label} is not a year`);
  return value;
}

function checkedPhotoId(value: unknown, year: string, label: string) {
  if (typeof value !== "string" || PHOTO_ID.exec(value)?.[1] !== year) fail(`${label} does not match its year`);
  return value;
}

function key(year: string, photoId: string) {
  return `${year}\0${photoId}`;
}

export function validatePhotoAliasMap(value: unknown, catalog: Catalog): PhotoAliasMap {
  const root = record(value, "root");
  exactKeys(root, [
    "schemaVersion",
    "status",
    "packageId",
    "packageClosedWorldSha256",
    "transitionLedgerSha256",
    "aliases",
    "retired"
  ], "root");
  if (root.schemaVersion !== 1) fail("unsupported schemaVersion");
  if (root.status !== "approved") fail("status must be approved");
  for (const field of ["packageId", "packageClosedWorldSha256", "transitionLedgerSha256"] as const) {
    if (typeof root[field] !== "string" || !SHA256.test(root[field])) fail(`${field} must be a lowercase SHA-256`);
  }
  if (!Array.isArray(root.aliases) || !Array.isArray(root.retired)) fail("aliases and retired must be arrays");

  const availableYears = new Set(catalog.years.map(({ year }) => year));
  const aliases = new Map<string, PhotoAliasTarget>();
  const retired = new Set<string>();

  for (const [index, value] of root.aliases.entries()) {
    const item = record(value, `aliases[${index}]`);
    exactKeys(item, ["oldYear", "oldPhotoId", "newYear", "newPhotoId"], `aliases[${index}]`);
    const oldYear = checkedYear(item.oldYear, `aliases[${index}].oldYear`);
    const oldPhotoId = checkedPhotoId(item.oldPhotoId, oldYear, `aliases[${index}].oldPhotoId`);
    const newYear = checkedYear(item.newYear, `aliases[${index}].newYear`);
    const newPhotoId = checkedPhotoId(item.newPhotoId, newYear, `aliases[${index}].newPhotoId`);
    if (!availableYears.has(newYear)) fail(`aliases[${index}] targets a year outside the catalogue`);
    const oldKey = key(oldYear, oldPhotoId);
    if (aliases.has(oldKey)) fail(`aliases[${index}] duplicates an old photo ID`);
    aliases.set(oldKey, { year: newYear, photoId: newPhotoId });
  }

  for (const [index, value] of root.retired.entries()) {
    const item = record(value, `retired[${index}]`);
    exactKeys(item, ["oldYear", "oldPhotoId"], `retired[${index}]`);
    const oldYear = checkedYear(item.oldYear, `retired[${index}].oldYear`);
    const oldPhotoId = checkedPhotoId(item.oldPhotoId, oldYear, `retired[${index}].oldPhotoId`);
    const oldKey = key(oldYear, oldPhotoId);
    if (aliases.has(oldKey) || retired.has(oldKey)) fail(`retired[${index}] duplicates an old photo ID`);
    retired.add(oldKey);
  }

  return {
    schemaVersion: 1,
    status: "approved",
    packageId: root.packageId as string,
    packageClosedWorldSha256: root.packageClosedWorldSha256 as string,
    transitionLedgerSha256: root.transitionLedgerSha256 as string,
    aliases,
    retired
  };
}

export function resolvePhotoAlias(map: PhotoAliasMap | null, year: string, photoId: string): PhotoAliasResolution {
  if (!map) return { status: "unchanged" };
  const oldKey = key(year, photoId);
  const target = map.aliases.get(oldKey);
  if (target) return { status: "alias", ...target };
  if (map.retired.has(oldKey)) return { status: "retired" };
  return { status: "unchanged" };
}
