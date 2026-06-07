#!/usr/bin/env node
"use strict";

/*
 * One-command release for PepStats.
 *
 *   npm run release            # release the version already in package.json
 *   npm run release -- patch   # bump patch (0.4.2 -> 0.4.3), commit, tag, release
 *   npm run release -- minor   # bump minor (0.4.2 -> 0.5.0)
 *   npm run release -- major   # bump major (0.4.2 -> 1.0.0)
 *   npm run release -- 0.6.0   # set an explicit version
 *
 * Steps: bump (optional) -> commit + tag + push (only if bumped) -> build the
 * NSIS installer -> create the GitHub release -> upload the installer asset.
 *
 * Auth uses the same Git Credential Manager token git already uses for pushes,
 * so there's nothing extra to configure (no `gh` required).
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const PKG_PATH = path.join(ROOT, "package.json");

function die(msg) {
  console.error("\n✖ " + msg);
  process.exit(1);
}
function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit", shell: process.platform === "win32", ...opts });
  if (res.status !== 0) die(`Command failed: ${cmd} ${args.join(" ")}`);
  return res;
}
function capture(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8", shell: process.platform === "win32", ...opts });
  return { status: res.status, out: (res.stdout || "").trim(), err: (res.stderr || "").trim() };
}

function bumpVersion(cur, level) {
  if (/^\d+\.\d+\.\d+$/.test(level)) return level; // explicit version
  const [maj, min, pat] = cur.split(".").map(Number);
  if (level === "major") return `${maj + 1}.0.0`;
  if (level === "minor") return `${maj}.${min + 1}.0`;
  if (level === "patch") return `${maj}.${min}.${pat + 1}`;
  die(`Unknown bump level "${level}" (use patch | minor | major | x.y.z).`);
}

function ghToken() {
  const res = spawnSync("git", ["credential", "fill"], {
    cwd: ROOT, encoding: "utf8",
    input: "protocol=https\nhost=github.com\n\n",
  });
  const line = (res.stdout || "").split(/\r?\n/).find((l) => l.startsWith("password="));
  if (!line) die("Couldn't get a GitHub token from git credential. Run `git push` once to authenticate, then retry.");
  return line.slice("password=".length);
}

function repoSlug() {
  const { out } = capture("git", ["remote", "get-url", "origin"]);
  const m = out.match(/github\.com[/:]([^/]+)\/(.+?)(?:\.git)?$/i);
  if (!m) die("Couldn't parse the GitHub owner/repo from the origin remote.");
  return `${m[1]}/${m[2]}`;
}

function api(method, host, pathname, token, { json, body, contentType } = {}) {
  return new Promise((resolve, reject) => {
    const payload = json ? Buffer.from(JSON.stringify(json)) : body || null;
    const req = https.request(
      {
        method, host, path: pathname,
        headers: {
          Authorization: "token " + token,
          "User-Agent": "pepstats-release",
          Accept: "application/vnd.github+json",
          ...(payload ? { "Content-Type": contentType || "application/json", "Content-Length": payload.length } : {}),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          let parsed = null;
          try { parsed = data ? JSON.parse(data) : null; } catch (_) { parsed = data; }
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(parsed);
          else reject(new Error(`HTTP ${res.statusCode}: ${(parsed && parsed.message) || data}`));
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

(async () => {
  const pkg = JSON.parse(fs.readFileSync(PKG_PATH, "utf8"));
  const level = process.argv[2];
  let version = pkg.version;
  let bumped = false;

  if (level) {
    version = bumpVersion(pkg.version, level);
    pkg.version = version;
    fs.writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + "\n");
    bumped = true;
    console.log(`• Bumped version: ${version}`);
  } else {
    console.log(`• Releasing current version: ${version}`);
  }

  const tag = "v" + version;
  const slug = repoSlug();
  const exeName = `PepStats-Setup-${version}.exe`;
  const exePath = path.join(ROOT, "dist", exeName);

  if (bumped) {
    run("git", ["add", "package.json"]);
    run("git", ["commit", "-m", `Release ${tag}`]);
    run("git", ["tag", tag]);
    run("git", ["push", "origin", "HEAD"]);
    run("git", ["push", "origin", tag]);
  }

  // Clear a stale installer of this version so the build can write fresh.
  try { if (fs.existsSync(exePath)) fs.unlinkSync(exePath); } catch (_) {}

  console.log("• Building NSIS installer…");
  run("npx", ["electron-builder", "--win", "nsis", "--publish", "never"]);
  if (!fs.existsSync(exePath)) die(`Build finished but ${exeName} was not found in dist/.`);

  console.log("• Authenticating with GitHub…");
  const token = ghToken();

  console.log(`• Creating release ${tag} on ${slug}…`);
  const rel = await api("POST", "api.github.com", `/repos/${slug}/releases`, token, {
    json: { tag_name: tag, name: `PepStats ${tag}`, body: `PepStats ${tag}`, draft: false, prerelease: false },
  });

  console.log("• Uploading installer…");
  const buf = fs.readFileSync(exePath);
  const up = await api(
    "POST", "uploads.github.com",
    `/repos/${slug}/releases/${rel.id}/assets?name=${encodeURIComponent(exeName)}`,
    token,
    { body: buf, contentType: "application/octet-stream" }
  );

  console.log(`\n✓ Released ${tag}`);
  console.log(`  ${rel.html_url}`);
  console.log(`  asset: ${up.name} (${(up.size / 1048576).toFixed(1)} MB)`);
})().catch((e) => die(e.message));
