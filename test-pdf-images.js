    // Run this on your server: node test-pdf-images.js
// It will tell you exactly why images aren't embedding

import mongoose from "mongoose";
import dotenv from "dotenv";
dotenv.config();

// ── Paste your MongoDB URI ──
const MONGO_URI = process.env.MONGODB_URI || process.env.DATABASE_URL;
const PROJECT_ID = process.argv[2]; // pass projectId as argument

if (!PROJECT_ID) {
  console.error("Usage: node test-pdf-images.js <projectId>");
  process.exit(1);
}

await mongoose.connect(MONGO_URI);
console.log("✓ Connected to MongoDB");

const doc = await mongoose.connection.db
  .collection("projects")
  .findOne({ _id: new mongoose.Types.ObjectId(PROJECT_ID) });

if (!doc) {
  console.error("✗ Project not found");
  process.exit(1);
}

console.log("\n=== ARTIFACTS KEYS ===");
console.log(Object.keys(doc.artifacts ?? {}));

console.log("\n=== COVER ===");
const cover = doc.artifacts?.cover ?? {};
console.log("Cover keys:", Object.keys(cover));
for (const [k, v] of Object.entries(cover)) {
  if (typeof v === "string") {
    console.log(`  cover.${k}: ${v.startsWith("data:") ? `base64 ${Math.round(v.length/1024)}kb` : v.slice(0,80)}`);
  } else {
    console.log(`  cover.${k}:`, typeof v, v);
  }
}

console.log("\n=== ILLUSTRATIONS ===");
for (const ill of (doc.artifacts?.illustrations ?? [])) {
  console.log(`\n  Ch${ill.chapterNumber}:`);
  console.log(`    selectedVariantIndex: ${ill.selectedVariantIndex}`);
  console.log(`    variants count: ${ill.variants?.length ?? 0}`);
  for (const v of (ill.variants ?? [])) {
    const url = v.imageUrl ?? "";
    console.log(`    variant[${v.variantIndex}]: selected=${v.selected} imageUrl=${url ? (url.startsWith("data:") ? `base64 ${Math.round(url.length/1024)}kb` : url.slice(0,80)) : "NULL"}`);
  }
}

console.log("\n=== Node.js version ===");
console.log(process.version);
console.log("AbortSignal.timeout supported:", typeof AbortSignal?.timeout === "function");

await mongoose.disconnect();