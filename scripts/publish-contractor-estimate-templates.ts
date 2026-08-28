// Run after applying migration 0102:
//
// npm run publish:contractor-templates -- \
//   --heatcraft "/path/to/Heatcraft Selector Model.xlsx" \
//   --carrier "/path/to/Carrier Survey.xlsx"
//
// Add --dry-run to validate both workbooks and print their checksums without
// connecting to Supabase. Publishing requires NEXT_PUBLIC_SUPABASE_URL and
// SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_ROLE_KEY) in .env.local.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";

config({ path: resolve(process.cwd(), ".env.local") });

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const MAX_XLSX_BYTES = 15 * 1024 * 1024;
const BUCKET = "contractor-estimate-templates";

type TemplateKey = "heatcraft" | "carrier";

type TemplateSpec = {
  key: TemplateKey;
  flag: `--${TemplateKey}`;
  displayName: string;
  description: string;
  versionLabel: string;
  downloadName: string;
};

const TEMPLATE_SPECS: TemplateSpec[] = [
  {
    key: "heatcraft",
    flag: "--heatcraft",
    displayName: "Heatcraft form",
    description: "Approved Heatcraft vault configuration selector workbook.",
    versionLabel: "Version 7/21/2026",
    downloadName: "Heatcraft Selector Model.xlsx",
  },
  {
    key: "carrier",
    flag: "--carrier",
    displayName: "Carrier survey",
    description: "Approved Carrier equipment survey workbook.",
    versionLabel: "Current approved version",
    downloadName: "Carrier Survey FRESH.xlsx",
  },
];

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const wantsHelp = args.includes("--help") || args.includes("-h");

const valueFor = (flag: string) => {
  const index = args.indexOf(flag);
  if (index < 0) return "";
  return args[index + 1] || "";
};

if (wantsHelp) {
  console.log([
    "Publish the approved private contractor estimate templates.",
    "",
    "Required:",
    "  --heatcraft <xlsx path>",
    "  --carrier <xlsx path>",
    "",
    "Optional:",
    "  --dry-run    Validate files without contacting Supabase",
  ].join("\n"));
  process.exit(0);
}

type ValidatedTemplate = {
  spec: TemplateSpec;
  sourcePath: string;
  contents: Buffer;
  sizeBytes: number;
  sha256: string;
  storagePath: string;
};

async function validateTemplate(spec: TemplateSpec): Promise<ValidatedTemplate> {
  const sourcePath = resolve(valueFor(spec.flag));
  if (!valueFor(spec.flag)) {
    throw new Error(`${spec.flag} is required.`);
  }
  if (!/\.xlsx$/i.test(sourcePath)) {
    throw new Error(`${basename(sourcePath)} must be an .xlsx workbook.`);
  }
  const contents = await readFile(sourcePath);
  if (contents.length < 4 || contents.length > MAX_XLSX_BYTES) {
    throw new Error(`${basename(sourcePath)} must be between 1 byte and 15 MB.`);
  }
  if (
    contents[0] !== 0x50
    || contents[1] !== 0x4b
    || contents[2] !== 0x03
    || contents[3] !== 0x04
    || !contents.includes(Buffer.from("[Content_Types].xml"))
    || !contents.includes(Buffer.from("xl/workbook.xml"))
  ) {
    throw new Error(`${basename(sourcePath)} is not a valid Office Open XML workbook.`);
  }
  const sha256 = createHash("sha256").update(contents).digest("hex");
  return {
    spec,
    sourcePath,
    contents,
    sizeBytes: contents.length,
    sha256,
    storagePath: `${spec.key}/${sha256}.xlsx`,
  };
}

async function main() {
  const validated = await Promise.all(TEMPLATE_SPECS.map(validateTemplate));
  for (const template of validated) {
    console.log(`${template.spec.displayName}: ${template.sizeBytes} bytes · ${template.sha256}`);
  }
  if (dryRun) {
    console.log("Dry run complete. No files or metadata were changed.");
    return;
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secret = process.env.SUPABASE_SECRET_KEY
    || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !secret) {
    throw new Error(
      "Publishing requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_ROLE_KEY) in .env.local.",
    );
  }

  const supabase = createClient(supabaseUrl, secret, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  for (const template of validated) {
    const { data: previous, error: previousError } = await supabase
      .from("contractor_estimate_templates")
      .select("storage_path")
      .eq("template_key", template.spec.key)
      .maybeSingle();
    if (previousError) {
      throw new Error(`Load ${template.spec.displayName} metadata: ${previousError.message}`);
    }

    const { error: uploadError } = await supabase.storage
      .from(BUCKET)
      .upload(template.storagePath, template.contents, {
        contentType: XLSX_MIME,
        upsert: true,
      });
    if (uploadError) {
      throw new Error(`Upload ${template.spec.displayName}: ${uploadError.message}`);
    }

    const { error: metadataError } = await supabase
      .from("contractor_estimate_templates")
      .upsert({
        template_key: template.spec.key,
        display_name: template.spec.displayName,
        description: template.spec.description,
        version_label: template.spec.versionLabel,
        original_name: template.spec.downloadName,
        storage_path: template.storagePath,
        mime_type: XLSX_MIME,
        size_bytes: template.sizeBytes,
        sha256: template.sha256,
        is_active: true,
        published_at: new Date().toISOString(),
      }, { onConflict: "template_key" });
    if (metadataError) {
      if (previous?.storage_path !== template.storagePath) {
        await supabase.storage.from(BUCKET).remove([template.storagePath]);
      }
      throw new Error(`Publish ${template.spec.displayName} metadata: ${metadataError.message}`);
    }

    if (previous?.storage_path && previous.storage_path !== template.storagePath) {
      const { error: cleanupError } = await supabase.storage
        .from(BUCKET)
        .remove([previous.storage_path]);
      if (cleanupError) {
        console.warn(`Published ${template.spec.displayName}, but the superseded object could not be removed: ${cleanupError.message}`);
      }
    }
    console.log(`Published ${template.spec.displayName} as ${template.spec.downloadName}.`);
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
