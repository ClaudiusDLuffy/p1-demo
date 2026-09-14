import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { LEGACY_PHOTO_SOURCE, LEGACY_PHOTO_SOURCE_SHA256 } from "./legacyPersistenceSource";

type PhotoRow = { id: string; work_order_id: string; storage_path: string; uploader_id: string; uploader_name: string };
type Activity = { workOrderId: string; author: string; message: string; type: string; audit: unknown };
type ObjectRow = { file: File; contentType: string; bytes: Uint8Array };
export type PhotoPersistenceFailure =
  | `upload:before:${number}` | `upload:after:${number}` | `metadata:${number}`
  | "activity" | "metadata-delete" | "storage-delete";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  assert.equal(typeof field, "string", `Synthetic ${key} must be a string`);
  if (typeof field !== "string") throw new Error(`Invalid synthetic ${key}`);
  return field;
}

export function currentPhotoPersistenceSource(): string {
  const source = readFileSync("src/lib/db.ts", "utf8");
  const ast = ts.createSourceFile("db.ts", source, ts.ScriptTarget.Latest, true);
  const names = new Set(["uploadPhotos", "removePhoto"]);
  const functions = ast.statements.filter(statement => ts.isFunctionDeclaration(statement)
    && statement.name && names.has(statement.name.text));
  assert.equal(functions.length, 2, "Extract only the actual public photo functions");
  return functions.map(statement => statement.getText(ast)).join("\n\n");
}

export function verifyPhotoBaselineSource(source: string): void {
  assert.equal(createHash("sha256").update(source).digest("hex"), LEGACY_PHOTO_SOURCE_SHA256,
    "Current-mode characterization is valid only before changing production photo persistence");
}

// Real source bodies execute in a VM with synthetic IO ports. These ports model
// commit order and injected failures only, NOT Supabase/Storage authorization.
export function photoPersistenceHarness(options: {
  source?: string;
  failures?: readonly PhotoPersistenceFailure[];
  requireMetadataForStorageDelete?: boolean;
} = {}) {
  const objects = new Map<string, ObjectRow>();
  const photos: PhotoRow[] = [];
  const activities: Activity[] = [];
  const calls: string[] = [];
  const failures = new Set(options.failures);
  const actorId = "95000000-0000-4000-8000-000000000001";
  let uploadCount = 0;
  let metadataCount = 0;
  let identifier = 0;
  const nextId = () => `95000000-0000-4000-8000-${String(++identifier).padStart(12, "0")}`;
  const failure = (step: PhotoPersistenceFailure): Error | null => {
    if (!failures.delete(step)) return null;
    return new Error(`Synthetic failure at ${step}`);
  };
  const sb = {
    auth: { getUser: async () => ({ data: { user: { id: actorId } }, error: null }) },
    storage: { from: (bucket: string) => {
      assert.equal(bucket, "photos");
      return {
        upload: async (path: string, file: File, uploadOptions: { contentType: string; upsert: boolean }) => {
          uploadCount += 1;
          calls.push(`storage-upload:${path}`);
          assert.equal(uploadOptions.upsert, false);
          const before = failure(`upload:before:${uploadCount}`);
          if (before) return { error: before };
          assert.equal(objects.has(path), false, "The fixture does not overwrite objects");
          objects.set(path, { file, contentType: uploadOptions.contentType, bytes: new Uint8Array(await file.arrayBuffer()) });
          return { error: failure(`upload:after:${uploadCount}`) };
        },
        remove: async (paths: string[]) => {
          calls.push("storage-delete");
          const injected = failure("storage-delete");
          if (injected) return { error: injected };
          // SQL-only harness must independently prove this policy; here it is
          // an explicit response model for the uploader's second request.
          if (options.requireMetadataForStorageDelete
            && paths.some(path => !photos.some(photo => photo.storage_path === path))) {
            return { error: new Error("Synthetic Storage denial: metadata authorization was removed") };
          }
          for (const path of paths) objects.delete(path);
          return { error: null };
        },
      };
    } },
    from: (table: string) => {
      assert.equal(table, "photos");
      return {
        insert: async (row: unknown) => {
          metadataCount += 1;
          calls.push("metadata-insert");
          const injected = failure(`metadata:${metadataCount}`);
          if (injected) return { error: injected };
          assert.ok(isRecord(row));
          photos.push({ id: nextId(), work_order_id: stringField(row, "work_order_id"),
            storage_path: stringField(row, "storage_path"), uploader_id: stringField(row, "uploader_id"),
            uploader_name: stringField(row, "uploader_name") });
          return { error: null };
        },
        delete: () => {
          const filters = new Map<string, string>();
          const query = {
            eq: (column: string, value: string) => { filters.set(column, value); return query; },
            select: async (columns: string) => {
              assert.equal(columns, "id");
              calls.push("metadata-delete");
              const injected = failure("metadata-delete");
              if (injected) return { data: null, error: injected };
              const removed = photos.filter(photo => photo.work_order_id === filters.get("work_order_id")
                && photo.storage_path === filters.get("storage_path"));
              for (const row of removed) photos.splice(photos.indexOf(row), 1);
              return { data: removed.map(row => ({ id: row.id })), error: null };
            },
          };
          return query;
        },
      };
    },
  };
  const exports: Record<string, unknown> = {};
  runInNewContext(ts.transpileModule(options.source ?? LEGACY_PHOTO_SOURCE, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, {
    exports, supabase: () => sb, crypto: { randomUUID: nextId },
    Date: { now: () => 1_789_000_000_000 }, Error,
    insertActivity: async (workOrderId: string, author: string, message: string, type: string, audit: unknown) => {
      calls.push("activity-insert");
      const injected = failure("activity");
      if (injected) throw injected;
      activities.push({ workOrderId, author, message, type, audit });
    },
  }, { filename: "synthetic-legacy-photo-persistence.ts" });
  const uploadFunction = exports.uploadPhotos;
  const removeFunction = exports.removePhoto;
  assert.equal(typeof uploadFunction, "function");
  assert.equal(typeof removeFunction, "function");
  if (typeof uploadFunction !== "function" || typeof removeFunction !== "function") throw new Error("Missing photo exports");
  return {
    objects, photos, activities, calls, actorId,
    async upload(files: File[], workOrderId = "WOT9500001") {
      const result: unknown = await uploadFunction(workOrderId, files, "Synthetic uploader", { eventKey: "photo_added" });
      assert.ok(Array.isArray(result));
      return Array.from(result, (path: unknown) => {
        assert.equal(typeof path, "string");
        if (typeof path !== "string") throw new Error("Invalid path result");
        return path;
      });
    },
    async remove(path: string, workOrderId = "WOT9500001") {
      const result: unknown = await removeFunction(workOrderId, path);
      assert.ok(isRecord(result));
      assert.equal(typeof result.success, "boolean");
      return { success: result.success === true, error: result.error };
    },
  };
}
