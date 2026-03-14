#!/usr/bin/env node
/**
 * CCM 악보 자동 수집 파이프라인 (Puppeteer + Claude Vision)
 *
 * Chrome 브라우저를 직접 제어하여 Google에서 악보 이미지를 검색·다운로드하고,
 * Claude Vision으로 파싱하여 DB에 저장합니다.
 *
 * 사용법:
 *   node scripts/pipeline.mjs                     # ccm-songs.json 전체 처리
 *   node scripts/pipeline.mjs --limit 5           # 최대 5곡만
 *   node scripts/pipeline.mjs --query "은혜 악보"  # 특정 곡 1개
 *   node scripts/pipeline.mjs --headed            # 브라우저 화면 보기 (디버그용)
 *
 * 환경변수 (필수):
 *   ANTHROPIC_API_KEY   - Claude API 키
 *
 * 환경변수 (선택):
 *   DB_HOST, DB_PORT, DB_USER, DB_PASS, DB_NAME
 *   CHROME_PATH         - Chrome 실행 경로 (자동 감지)
 *
 * 설치:
 *   npm install puppeteer-core mysql2
 */

import puppeteer from "puppeteer-core";
import { createConnection } from "mysql2/promise";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── 환경변수 검증 ───
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  console.error("❌ ANTHROPIC_API_KEY 환경변수를 설정하세요.");
  process.exit(1);
}

// ─── Chrome 경로 자동 감지 ───
function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;

  const paths = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ];

  for (const p of paths) {
    if (existsSync(p)) return p;
  }

  throw new Error("Chrome을 찾을 수 없습니다. CHROME_PATH 환경변수를 설정하세요.");
}

// ─── DB ───
function getDbConfig() {
  return {
    host: process.env.DB_HOST || "localhost",
    port: parseInt(process.env.DB_PORT || "3306"),
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASS || "root",
    database: process.env.DB_NAME || "ccmdb",
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Puppeteer: Google 이미지 검색 & 다운로드 ───
async function searchAndDownload(browser, songTitle, savePath) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });

  try {
    const query = `${songTitle} 악보`;
    const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&tbm=isch`;

    console.log(`   🌐 Chrome: "${query}" 이미지 검색...`);
    await page.goto(searchUrl, { waitUntil: "networkidle2", timeout: 15000 });

    // Wait for image thumbnails to load
    await sleep(2000);

    // Get image thumbnail URLs from search results
    const imageUrls = await page.evaluate(() => {
      const imgs = document.querySelectorAll("img.YQ4gaf");
      const urls = [];
      for (const img of imgs) {
        const src = img.src || img.getAttribute("data-src");
        // Skip tiny icons and base64 thumbnails
        if (src && src.startsWith("http") && !src.includes("gstatic.com/images")) {
          urls.push(src);
        }
      }
      return urls.slice(0, 10);
    });

    if (imageUrls.length === 0) {
      // Fallback: try clicking first image to get full resolution
      console.log("   🔄 썸네일 직접 클릭하여 원본 이미지 가져오기...");

      const thumbnails = await page.$$("img.YQ4gaf");
      if (thumbnails.length === 0) {
        throw new Error("검색 결과 이미지 없음");
      }

      // Click first few thumbnails to find a good one
      for (let i = 0; i < Math.min(5, thumbnails.length); i++) {
        try {
          await thumbnails[i].click();
          await sleep(1500);

          // Get the full-size image URL from the side panel
          const fullUrl = await page.evaluate(() => {
            // Look for the large preview image
            const sideImg = document.querySelector(
              'img[jsname="kn3ccd"], img[jsname="JuXqh"], c-wiz img[src^="http"]'
            );
            if (sideImg) {
              const src = sideImg.src;
              if (src && src.startsWith("http") && !src.includes("gstatic")) {
                return src;
              }
            }
            // Alternative: look for any large image in the panel
            const imgs = document.querySelectorAll("img");
            for (const img of imgs) {
              if (
                img.naturalWidth > 300 &&
                img.src &&
                img.src.startsWith("http") &&
                !img.src.includes("gstatic") &&
                !img.src.includes("google")
              ) {
                return img.src;
              }
            }
            return null;
          });

          if (fullUrl) {
            imageUrls.push(fullUrl);
            break;
          }
        } catch {
          continue;
        }
      }
    }

    if (imageUrls.length === 0) {
      // Last resort: screenshot the search results page
      console.log("   📸 검색 결과 페이지 스크린샷 캡처...");
      const screenshot = await page.screenshot({ fullPage: false });
      writeFileSync(savePath, screenshot);
      return screenshot;
    }

    // Try to download the best image
    console.log(`   📋 이미지 후보 ${imageUrls.length}개 발견`);

    for (const url of imageUrls) {
      try {
        // Navigate to the image directly
        const imgPage = await browser.newPage();
        const response = await imgPage.goto(url, {
          waitUntil: "networkidle2",
          timeout: 10000,
        });

        const contentType = response.headers()["content-type"] || "";

        if (contentType.startsWith("image/")) {
          const buffer = await response.buffer();
          // Only accept reasonable-sized images (likely sheet music)
          if (buffer.length > 20000) {
            writeFileSync(savePath, buffer);
            await imgPage.close();
            console.log(`   📥 이미지 다운로드: ${(buffer.length / 1024).toFixed(0)}KB`);
            return buffer;
          }
        }

        // If it's a webpage, try to find the sheet music image on the page
        if (contentType.includes("html")) {
          await sleep(1000);

          // Look for large images on the page that look like sheet music
          const sheetImageUrl = await imgPage.evaluate(() => {
            const imgs = document.querySelectorAll("img");
            let best = null;
            let bestSize = 0;
            for (const img of imgs) {
              const w = img.naturalWidth || img.width;
              const h = img.naturalHeight || img.height;
              const size = w * h;
              if (
                size > bestSize &&
                w > 400 &&
                h > 300 &&
                img.src &&
                img.src.startsWith("http")
              ) {
                best = img.src;
                bestSize = size;
              }
            }
            return best;
          });

          if (sheetImageUrl) {
            const response2 = await imgPage.goto(sheetImageUrl, {
              waitUntil: "networkidle2",
              timeout: 10000,
            });
            const ct2 = response2.headers()["content-type"] || "";
            if (ct2.startsWith("image/")) {
              const buffer2 = await response2.buffer();
              if (buffer2.length > 20000) {
                writeFileSync(savePath, buffer2);
                await imgPage.close();
                console.log(`   📥 페이지 내 이미지 다운로드: ${(buffer2.length / 1024).toFixed(0)}KB`);
                return buffer2;
              }
            }
          }

          // Screenshot the page as fallback
          const pageScreenshot = await imgPage.screenshot({
            fullPage: true,
            type: "png",
          });
          if (pageScreenshot.length > 50000) {
            writeFileSync(savePath, pageScreenshot);
            await imgPage.close();
            console.log(`   📸 페이지 스크린샷: ${(pageScreenshot.length / 1024).toFixed(0)}KB`);
            return pageScreenshot;
          }
        }

        await imgPage.close();
      } catch {
        continue;
      }
    }

    // Absolute fallback: screenshot the Google results
    console.log("   📸 Google 결과 스크린샷으로 대체...");
    const fallbackScreenshot = await page.screenshot({ fullPage: false, type: "png" });
    writeFileSync(savePath, fallbackScreenshot);
    return fallbackScreenshot;
  } finally {
    await page.close();
  }
}

// ─── Claude Vision 파싱 ───
const SYSTEM_PROMPT = `당신은 CCM(찬양) 악보 이미지를 분석하여 JSON 멜로디 데이터로 변환하는 전문가입니다.

## 작업
악보 이미지를 정밀하게 읽고, 모든 음표의 음높이·박자·가사·코드를 정확하게 추출하세요.
이미지가 악보가 아니거나 읽을 수 없는 경우 {"error": "not_sheet_music"} 을 반환하세요.

## 출력 형식
반드시 아래 JSON 형식으로만 응답하세요. 마크다운 코드 펜스나 설명 없이 순수 JSON만 반환하세요.

{
  "title": "곡 제목",
  "artist": "아티스트",
  "key": "G",
  "timeSignature": "4/4",
  "tempo": 120,
  "sections": [
    {"measureIndex": 0, "label": "1절"},
    {"measureIndex": 8, "label": "후렴"}
  ],
  "measures": [
    {
      "notes": [
        {"p": "D4", "d": 0.5, "l": "주", "c": "G"},
        {"p": "D4", "d": 0.5, "l": "님"},
        {"p": "E4", "d": 1, "l": "의"}
      ]
    }
  ]
}

## 필드 설명
- title: 악보에 표기된 곡 제목
- artist: 악보에 표기된 아티스트/작곡가
- key: 조성 (예: G, Bb, F#m)
- timeSignature: 박자표 (예: 4/4, 3/4, 6/8)
- tempo: BPM (악보에 없으면 적절히 추정)
- p: 음높이 (C4, D#4, Bb4 등). 쉼표는 "R"
- d: 박자 길이. 4분음표=1, 8분음표=0.5, 2분음표=2, 온음표=4, 점4분음표=1.5
- l: 가사 (한 음절). 없으면 생략
- c: 코드. 바뀌는 음에만 표시

## 악보 읽기 규칙
1. 음자리표와 조표(#, b)를 정확히 반영하여 음높이 결정
2. 임시표(♯, ♭, ♮)는 해당 마디 내에서만 적용
3. 음표 모양으로 박자 결정 (온=4, 2분=2, 4분=1, 8분=0.5, 16분=0.25, 점=1.5배)
4. 붙임줄(타이)로 연결된 음은 합산
5. 한 마디의 총 박자 합 = 박자표에 맞아야 함
6. 가사는 음절 단위로 1:1 매핑
7. 반복 기호는 펼쳐서 포함
8. 쉼표도 처리 (p: "R")
9. 섹션 라벨은 한글 사용 (1절, 후렴, 브릿지 등)`;

async function parseWithClaude(imageBuffer) {
  console.log("   🤖 Claude Vision API 호출 중...");

  const content = [
    {
      type: "image",
      source: {
        type: "base64",
        media_type: "image/png",
        data: imageBuffer.toString("base64"),
      },
    },
    {
      type: "text",
      text: "이 악보 이미지를 분석하여 JSON 멜로디 데이터로 변환해주세요. 모든 음표의 음높이, 박자, 가사, 코드를 정확하게 읽어주세요.",
    },
  ];

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 16384,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content }],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Claude API 오류 (${res.status}): ${err}`);
  }

  const data = await res.json();
  let result = data.content[0].text.trim();

  if (result.startsWith("```")) {
    result = result.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  }

  return JSON.parse(result);
}

// ─── DB ───
async function getExistingSongs(conn) {
  const [rows] = await conn.execute(
    "SELECT s.id, s.title, s.artist, (SELECT COUNT(*) FROM song_melodies sm WHERE sm.song_id = s.id) as has_melody FROM songs s"
  );
  return rows;
}

async function createSongAndMelody(conn, melody) {
  const title = melody.title || "Unknown";
  const artist = melody.artist || "Unknown";
  const key = melody.key || "C";
  const timeSignature = melody.timeSignature || "4/4";
  const tempo = melody.tempo || 120;

  const [existing] = await conn.execute(
    "SELECT id FROM songs WHERE title = ?",
    [title]
  );

  let songId;
  if (existing.length > 0) {
    songId = existing[0].id;
    console.log(`   ℹ️  곡 "${title}" 이미 존재 (ID: ${songId}), 멜로디만 업데이트`);
  } else {
    const [result] = await conn.execute(
      `INSERT INTO songs (title, artist, original_key, tempo, time_signature, genre, view_count, added_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'CCM', 0, 0, NOW(), NOW())`,
      [title, artist, key, tempo, timeSignature]
    );
    songId = result.insertId;
    console.log(`   ✅ 곡 생성: "${title}" (ID: ${songId})`);
  }

  const sectionsJson = JSON.stringify(melody.sections || []);
  const measuresJson = JSON.stringify(melody.measures || []);

  const [existingMelody] = await conn.execute(
    "SELECT id FROM song_melodies WHERE song_id = ?",
    [songId]
  );

  if (existingMelody.length > 0) {
    await conn.execute(
      `UPDATE song_melodies SET melody_key = ?, time_signature = ?, sections_json = ?, measures_json = ? WHERE song_id = ?`,
      [key, timeSignature, sectionsJson, measuresJson, songId]
    );
  } else {
    await conn.execute(
      `INSERT INTO song_melodies (song_id, melody_key, time_signature, sections_json, measures_json) VALUES (?, ?, ?, ?, ?)`,
      [songId, key, timeSignature, sectionsJson, measuresJson]
    );
  }

  const totalNotes = melody.measures.reduce((s, m) => s + m.notes.length, 0);
  console.log(`   ✅ 멜로디 저장: ${melody.measures.length}마디, ${totalNotes}음표`);
  return songId;
}

function loadSongList() {
  const listPath = join(__dirname, "ccm-songs.json");
  if (!existsSync(listPath)) {
    console.error(`❌ ${listPath} 파일이 없습니다.`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(listPath, "utf-8"));
}

// ─── 메인 ───
async function main() {
  const args = process.argv.slice(2);
  let limit = Infinity;
  let singleQuery = null;
  let headed = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--limit" && args[i + 1]) {
      limit = parseInt(args[i + 1]);
      i++;
    } else if (args[i] === "--query" && args[i + 1]) {
      singleQuery = args[i + 1];
      i++;
    } else if (args[i] === "--headed") {
      headed = true;
    }
  }

  // Launch Chrome
  const chromePath = findChrome();
  console.log(`\n🌐 Chrome 경로: ${chromePath}`);
  console.log(`   모드: ${headed ? "화면 표시 (headed)" : "백그라운드 (headless)"}\n`);

  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: headed ? false : "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--window-size=1400,900",
    ],
    defaultViewport: { width: 1400, height: 900 },
  });

  const conn = await createConnection(getDbConfig());
  const imgDir = join(__dirname, "downloads");
  const outputDir = join(__dirname, "output");
  mkdirSync(imgDir, { recursive: true });
  mkdirSync(outputDir, { recursive: true });

  console.log("🎵 CCM 악보 자동 수집 파이프라인 시작\n");

  // Get existing songs
  const existingSongs = await getExistingSongs(conn);
  const songsWithMelody = new Set(
    existingSongs.filter((s) => s.has_melody > 0).map((s) => s.title)
  );
  console.log(`📊 DB 현황: ${existingSongs.length}곡 등록, ${songsWithMelody.size}곡 멜로디 있음\n`);

  // Determine songs to process
  let songsToProcess = [];
  if (singleQuery) {
    songsToProcess = [{ title: singleQuery, artist: "" }];
  } else {
    const songList = loadSongList();
    songsToProcess = songList.filter((s) => !songsWithMelody.has(s.title));
    console.log(`📋 처리 대상: ${songsToProcess.length}곡 (전체 ${songList.length}곡 중 멜로디 없는 곡)\n`);
  }

  if (songsToProcess.length === 0) {
    console.log("✅ 모든 곡에 멜로디가 등록되어 있습니다!");
    await browser.close();
    await conn.end();
    return;
  }

  let processed = 0;
  let succeeded = 0;
  let failed = 0;
  const results = [];

  for (const song of songsToProcess) {
    if (processed >= limit) break;
    processed++;

    console.log(`\n${"─".repeat(50)}`);
    console.log(`[${processed}/${Math.min(songsToProcess.length, limit)}] 🎵 ${song.title}${song.artist ? ` - ${song.artist}` : ""}`);

    try {
      // 1. Chrome으로 Google 이미지 검색 & 다운로드
      const safeName = song.title.replace(/[^가-힣a-zA-Z0-9]/g, "_");
      const imgPath = join(imgDir, `${safeName}.png`);

      const imageBuffer = await searchAndDownload(browser, song.title, imgPath);

      if (!imageBuffer || imageBuffer.length < 5000) {
        console.log("   ❌ 유효한 이미지를 찾지 못함");
        results.push({ title: song.title, status: "no_image" });
        failed++;
        continue;
      }

      // 2. Claude Vision으로 파싱
      const melody = await parseWithClaude(imageBuffer);

      // Check for error response
      if (melody.error) {
        console.log(`   ⚠️  AI 판단: ${melody.error}`);
        results.push({ title: song.title, status: "not_sheet_music" });
        failed++;
        continue;
      }

      if (!melody.measures || melody.measures.length === 0) {
        console.log("   ❌ 파싱 결과 비어있음");
        results.push({ title: song.title, status: "parse_empty" });
        failed++;
        continue;
      }

      // Fallback title/artist
      if (!melody.title || melody.title === "Unknown") melody.title = song.title;
      if ((!melody.artist || melody.artist === "Unknown") && song.artist) melody.artist = song.artist;

      // 3. JSON 백업
      const jsonPath = join(outputDir, `${safeName}.json`);
      writeFileSync(jsonPath, JSON.stringify(melody, null, 2));
      console.log(`   💾 JSON: ${jsonPath}`);

      // 4. DB 저장
      const songId = await createSongAndMelody(conn, melody);

      results.push({
        title: melody.title,
        songId,
        measures: melody.measures.length,
        status: "success",
      });
      succeeded++;

      // 과부하 방지
      await sleep(3000);
    } catch (e) {
      console.log(`   ❌ 오류: ${e.message}`);
      results.push({ title: song.title, status: "error", error: e.message });
      failed++;
    }
  }

  // 결과 요약
  console.log(`\n${"═".repeat(50)}`);
  console.log(`📊 파이프라인 완료`);
  console.log(`   ✅ 성공: ${succeeded}곡`);
  console.log(`   ❌ 실패: ${failed}곡`);
  console.log(`   📋 총 처리: ${processed}곡`);

  if (succeeded > 0) {
    console.log(`\n성공한 곡:`);
    results
      .filter((r) => r.status === "success")
      .forEach((r) => console.log(`   🎵 ${r.title} (ID: ${r.songId}, ${r.measures}마디)`));
  }

  if (failed > 0) {
    console.log(`\n실패한 곡:`);
    results
      .filter((r) => r.status !== "success")
      .forEach((r) => console.log(`   ⚠️  ${r.title}: ${r.status}${r.error ? ` (${r.error})` : ""}`));
  }

  const logPath = join(outputDir, `pipeline-log-${Date.now()}.json`);
  writeFileSync(logPath, JSON.stringify(results, null, 2));
  console.log(`\n📝 결과 로그: ${logPath}`);

  await browser.close();
  await conn.end();
}

main().catch((err) => {
  console.error(`\n❌ 파이프라인 오류: ${err.message}`);
  process.exit(1);
});
