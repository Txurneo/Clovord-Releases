const fs = require("fs");
const path = require("path");
const pngToIcoModule = require("png-to-ico");
const pngToIco = typeof pngToIcoModule === "function" ? pngToIcoModule : pngToIcoModule?.default;

if (typeof pngToIco !== "function") {
    console.error("❌ png-to-ico did not export a function.");
    process.exit(1);
}

async function ensureIcon() {
    const workspaceRoot = path.resolve(__dirname, "..", "..", "web", "clovord.com", "assets", "images", "icons");
    const primaryPng = path.join(workspaceRoot, "favicon.png");
    const fallbackPng = path.join(workspaceRoot, "favicon-small.png");

    if (!fs.existsSync(primaryPng)) {
        console.error(`❌ Source PNG not found at ${primaryPng}`);
        process.exitCode = 1;
        return;
    }

    const outputDir = path.resolve(__dirname, "..", "resources");
    const outputIco = path.join(outputDir, "app.ico");

    fs.mkdirSync(outputDir, { recursive: true });

    try {
        const sources = fs.existsSync(fallbackPng)
            ? [primaryPng, fallbackPng]
            : [primaryPng];
        const icoBuffer = await pngToIco(sources);
        fs.writeFileSync(outputIco, icoBuffer);
        console.log(`✅ Generated ${outputIco}`);
    } catch (error) {
        console.error("❌ Failed to generate icon:", error);
        process.exitCode = 1;
    }
}

ensureIcon();
