#!/usr/bin/env node
/**
 * CCM 악보 자동 수집 파이프라인
 *
 * Google에서 찬양 악보 이미지를 검색 → 다운로드 → Claude Vision으로 파싱 → DB 저장
 * DB에 이미 등록된 곡은 자동으로 건너뜁니다.
 *
 * 사용법:
 *   node scripts/pipeline.mjs                    # ccm-songs.json 목록 전체 처리
 *   node scripts/pipeline.mjs --limit 5          # 최대 5곡만 처리
 *   node scripts/pipeline.mjs --query "은혜 악보"  # 특정 검색어로 1곡 처리
 *
 * 환경변수 (필수):
 *   ANTHROPIC_API_KEY   - Claude API 키
 *   GOOGLE_API_KEY      - Google Custom Search API 키
 *   GOOGLE_CSE_ID       - Google Custom Search Engine ID
 *
 * 환경변수 (선택):
 *   DB_HOST, DB_PORT, DB_USER, DB_PASS, DB_NAME
 *
 * Google Custom Search 설정:
 *   1. https://programmablesearchengine.google.com/ 에서 검색엔진 생성
 *      - "이미지 검색" 켜기, "전체 웹 검색" 선택
 *   2. https://console.cloud.google.com/apis 에서 "Custom Search API" 사용 설정
 *   3. API 키 발급
 */

import { createConnection } from "mysql2/promise";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── 환경변수 검증 ───
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const GOOGLE_CSE_ID = process.env.GOOGLE_CSE_ID;

if (!ANTHROPIC_API_KEY) {
  console.error("❌ ANTHROPIC_API_KEY 환경변수를 설정하세요.");
  process.exit(1);
}
if (!GOOGLE_API_KEY || !GOOGLE_CSE_ID) {
  console.error("❌ GOOGLE_API_KEY, GOOGLE_CSE_ID 환경변수를 설정하세요.");
  console.error("   https://programmablesearchengine.google.com/ 에서 설정");
  process.exit(1);
}

// ─── DB 연결 ───
function getDbConfig() {
  return {
    host: process.env.DB_HOST || "localhost",
    port: parseInt(process.env.DB_PORT || "3306"),
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASS || "root",
    database: process.env.DB_NAME || "ccmdb",
  };
}

// ─── Google 이미지 검색 ───
async function searchSheetMusic(songTitle) {
  const query = `${songTitle} CCM 악보`;
  const url = new URL("https://www.googleapis.com/customsearch/v1");
  url.searchParams.set("key", GOOGLE_API_KEY);
  url.searchParams.set("cx", GOOGLE_CSE_ID);
  url.searchParams.set("q", query);
  url.searchParams.set("searchType", "image");
  url.searchParams.set("num", "5");
  url.searchParams.set("imgSize", "large");
  url.searchParams.set("fileType", "png,jpg");

  console.log(`   🔍 검색: "${query}"`);

  const res = await fetch(url.toString());
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Google API 오류 (${res.status}): ${err}`);
  }

  const data = await res.json();
  if (!data.items || data.items.length === 0) {
    return [];
  }

  return data.items.map((item) => ({
    url: item.link,
    title: item.title,
    width: item.image?.width || 0,
    height: item.image?.height || 0,
  }));
}

// ─── 이미지 다운로드 ───
async function downloadImage(imageUrl, savePath) {
  const res = await fetch(imageUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    },
    redirect: "follow",
  });

  if (!res.ok) {
    throw new Error(`이미지 다운로드 실패 (${res.status}): ${imageUrl}`);
  }

  const contentType = res.headers.get("content-type") || "";
  if (!contentType.startsWith("image/")) {
    throw new Error(`이미지가 아닌 응답: ${contentType}`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  writeFileSync(savePath, buffer);
  return buffer;
}

// ─── Claude Vision 파싱 ───
const SYSTEM_PROMPT = `당신은 CCM(찬양) 악보 이미지를 분석하여 JSON 멜로디 데이터로 변환하는 전문가입니다.

## 작업
악보 이미지를 정밀하게 읽고, 모든 음표의 음높이·박자·가사·코드를 정확하게 추출하세요.

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

async function parseWithClaude(imageBuffers) {
  console.log("   🤖 Claude Vision API 호출 중...");

  const content = [];
  for (const buf of imageBuffers) {
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: "image/png",
        data: buf.toString("base64"),
      },
    });
  }
  content.push({
    type: "text",
    text: "이 악보 이미지를 분석하여 JSON 멜로디 데이터로 변환해주세요. 모든 음표의 음높이, 박자, 가사, 코드를 정확하게 읽어주세요.",
  });

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

// ─── DB 저장 ───
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

  // Check if song with same title already exists
  const [existing] = await conn.execute(
    "SELECT id FROM songs WHERE title = ?",
    [title]
  );

  let songId;

  if (existing.length > 0) {
    songId = existing[0].id;
    console.log(`   ℹ️  곡 "${title}" 이미 존재 (ID: ${songId}), 멜로디만 업데이트`);
  } else {
    // Create song
    const [result] = await conn.execute(
      `INSERT INTO songs (title, artist, original_key, tempo, time_signature, genre, view_count, added_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'CCM', 0, 0, NOW(), NOW())`,
      [title, artist, key, tempo, timeSignature]
    );
    songId = result.insertId;
    console.log(`   ✅ 곡 생성: "${title}" (ID: ${songId})`);
  }

  // Save melody
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

// ─── 곡 목록 로드 ───
function loadSongList() {
  const listPath = join(__dirname, "ccm-songs.json");
  if (!existsSync(listPath)) {
    console.error(`❌ ${listPath} 파일이 없습니다.`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(listPath, "utf-8"));
}

// ─── 딜레이 ───
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── 메인 파이프라인 ───
async function main() {
  const args = process.argv.slice(2);

  let limit = Infinity;
  let singleQuery = null;

  // Parse args
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--limit" && args[i + 1]) {
      limit = parseInt(args[i + 1]);
      i++;
    } else if (args[i] === "--query" && args[i + 1]) {
      singleQuery = args[i + 1];
      i++;
    }
  }

  const conn = await createConnection(getDbConfig());
  const imgDir = join(__dirname, "downloads");
  const outputDir = join(__dirname, "output");
  mkdirSync(imgDir, { recursive: true });
  mkdirSync(outputDir, { recursive: true });

  console.log("\n🎵 CCM 악보 자동 수집 파이프라인 시작\n");

  // Get existing songs from DB
  const existingSongs = await getExistingSongs(conn);
  const existingTitles = new Set(existingSongs.map((s) => s.title));
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
    // Filter out songs that already have melodies
    songsToProcess = songList.filter(
      (song) => !songsWithMelody.has(song.title)
    );
    console.log(
      `📋 처리 대상: ${songsToProcess.length}곡 (전체 ${songList.length}곡 중 멜로디 없는 곡)\n`
    );
  }

  if (songsToProcess.length === 0) {
    console.log("✅ 모든 곡에 멜로디가 등록되어 있습니다!");
    await conn.end();
    return;
  }

  // Process each song
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
      // 1. Google에서 악보 이미지 검색
      const images = await searchSheetMusic(song.title);
      if (images.length === 0) {
        console.log("   ⚠️  검색 결과 없음, 건너뜀");
        results.push({ title: song.title, status: "no_results" });
        failed++;
        continue;
      }

      // 2. 첫 번째 이미지 다운로드 (가장 관련성 높은 것)
      let imageBuffer = null;
      let downloadedUrl = null;

      for (const img of images.slice(0, 3)) {
        try {
          const safeName = song.title.replace(/[^가-힣a-zA-Z0-9]/g, "_");
          const imgPath = join(imgDir, `${safeName}.png`);
          imageBuffer = await downloadImage(img.url, imgPath);
          downloadedUrl = img.url;
          console.log(`   📥 다운로드 완료: ${(imageBuffer.length / 1024).toFixed(0)}KB`);
          break;
        } catch (e) {
          console.log(`   ⚠️  다운로드 실패 (${e.message}), 다음 이미지 시도...`);
        }
      }

      if (!imageBuffer) {
        console.log("   ❌ 이미지 다운로드 실패");
        results.push({ title: song.title, status: "download_failed" });
        failed++;
        continue;
      }

      // 3. Claude Vision으로 파싱
      const melody = await parseWithClaude([imageBuffer]);

      if (!melody.measures || melody.measures.length === 0) {
        console.log("   ❌ 파싱 결과가 비어있음");
        results.push({ title: song.title, status: "parse_empty" });
        failed++;
        continue;
      }

      // Use song list title/artist if Claude didn't detect them
      if (!melody.title || melody.title === "Unknown") {
        melody.title = song.title;
      }
      if ((!melody.artist || melody.artist === "Unknown") && song.artist) {
        melody.artist = song.artist;
      }

      // 4. JSON 백업 저장
      const safeName = song.title.replace(/[^가-힣a-zA-Z0-9]/g, "_");
      const jsonPath = join(outputDir, `${safeName}.json`);
      writeFileSync(jsonPath, JSON.stringify(melody, null, 2));
      console.log(`   💾 JSON 백업: ${jsonPath}`);

      // 5. DB에 저장
      const songId = await createSongAndMelody(conn, melody);

      results.push({
        title: melody.title,
        songId,
        measures: melody.measures.length,
        status: "success",
      });
      succeeded++;

      // API 과부하 방지
      await sleep(2000);
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
      .forEach((r) => {
        console.log(`   🎵 ${r.title} (ID: ${r.songId}, ${r.measures}마디)`);
      });
  }

  if (failed > 0) {
    console.log(`\n실패한 곡:`);
    results
      .filter((r) => r.status !== "success")
      .forEach((r) => {
        console.log(`   ⚠️  ${r.title}: ${r.status}${r.error ? ` (${r.error})` : ""}`);
      });
  }

  // Save results log
  const logPath = join(outputDir, `pipeline-log-${Date.now()}.json`);
  writeFileSync(logPath, JSON.stringify(results, null, 2));
  console.log(`\n📝 결과 로그: ${logPath}`);

  await conn.end();
}

main().catch((err) => {
  console.error(`\n❌ 파이프라인 오류: ${err.message}`);
  process.exit(1);
});
