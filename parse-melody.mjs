#!/usr/bin/env node
/**
 * AI 악보 파싱 스크립트 (이미지 → JSON 멜로디)
 *
 * 악보 사진(PNG/JPG)을 Claude Vision으로 분석하여
 * 음높이, 박자, 코드, 가사를 자동으로 추출합니다.
 *
 * 사용법:
 *   node scripts/parse-melody.mjs <songId> <이미지파일>
 *   node scripts/parse-melody.mjs 1 samples/song1.png
 *   node scripts/parse-melody.mjs 1 samples/song1.jpg samples/song1-2.jpg  (여러 장)
 *
 * 환경변수:
 *   ANTHROPIC_API_KEY  - Claude API 키 (필수)
 *   DB_HOST            - MySQL 호스트 (기본: localhost)
 *   DB_PORT            - MySQL 포트 (기본: 3306)
 *   DB_USER            - MySQL 사용자 (기본: root)
 *   DB_PASS            - MySQL 비밀번호 (기본: root)
 *   DB_NAME            - MySQL DB명 (기본: ccmdb)
 *
 * 설치:
 *   npm install mysql2 (한 번만)
 */

import { readFileSync } from "fs";
import { basename, extname } from "path";
import { createConnection } from "mysql2/promise";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  console.error("❌ ANTHROPIC_API_KEY 환경변수를 설정하세요.");
  console.error("   export ANTHROPIC_API_KEY=sk-ant-...");
  process.exit(1);
}

const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp"];

function getMediaType(filePath) {
  const ext = extname(filePath).toLowerCase();
  const types = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
  };
  return types[ext] || null;
}

function isImageFile(filePath) {
  return IMAGE_EXTENSIONS.includes(extname(filePath).toLowerCase());
}

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
- sections: 섹션 정보 (1절, 2절, 후렴, 브릿지 등)
- measures: 마디 배열
  - notes: 음표 배열
    - p: 음높이 (C4, D#4, Bb4 등). 옥타브 포함. 쉼표는 "R"
    - d: 박자 길이. 4분음표=1, 8분음표=0.5, 2분음표=2, 온음표=4, 점4분음표=1.5, 16분음표=0.25
    - l: 가사 (한 음절). 가사가 없으면 생략
    - c: 코드 (G, D/F#, Am7 등). 코드가 바뀌는 음에만 표시

## 악보 읽기 규칙
1. **음높이**: 오선보의 음자리표(높은음자리표/낮은음자리표)와 조표(#, b)를 정확히 반영
   - 조표에 의한 변화음을 반드시 적용 (예: G장조면 F는 항상 F#)
   - 임시표(♯, ♭, ♮)가 있으면 해당 마디 내에서만 적용
2. **박자**: 음표 모양(꼬리, 깃발, 점)을 정확히 읽기
   - 온음표(○)=4, 2분음표(d 빈)=2, 4분음표(d 채움)=1, 8분음표(깃발1)=0.5, 16분음표(깃발2)=0.25
   - 점음표는 원래 길이의 1.5배
   - 붙임줄(타이)로 연결된 음은 합산
   - 한 마디의 총 박자 합이 박자표에 맞아야 함
3. **가사**: 음표 아래 한글 가사를 음절 단위로 정확히 읽기
4. **코드**: 악보 위에 표기된 코드 기호를 정확히 읽기 (해당 위치의 첫 음에 "c" 필드로 연결)
5. **섹션**: 1절, 2절, 후렴, 브릿지, 간주 등 구분 표시를 읽기
6. **반복**: 반복 기호(𝄆)가 있으면 반복된 내용을 펼쳐서 모두 포함
7. **쉼표**: 쉼표도 음표처럼 처리 (p: "R", d: 해당 길이, l 없음)
8. 여러 장의 이미지가 주어지면 순서대로 이어서 하나의 곡으로 합치기

## 주의사항
- 음높이를 정확히 읽는 것이 가장 중요합니다. 오선의 줄/칸 위치를 신중하게 판단하세요.
- 불확실한 음은 코드 구성음을 참고하여 가장 합리적인 음을 선택하세요.
- 한글 가사의 음절 분리를 정확히 하세요 (예: "사랑" → "사", "랑")`;

// ─── Claude API 호출 (이미지) ───
async function callClaudeWithImages(imagePaths) {
  console.log("🤖 Claude Vision API 호출 중...");

  // Build content array with images
  const content = [];

  for (const imgPath of imagePaths) {
    const mediaType = getMediaType(imgPath);
    if (!mediaType) {
      throw new Error(`지원하지 않는 이미지 형식: ${imgPath}`);
    }

    const imageData = readFileSync(imgPath);
    const base64 = imageData.toString("base64");

    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: mediaType,
        data: base64,
      },
    });

    console.log(`   📷 ${basename(imgPath)} (${(imageData.length / 1024).toFixed(0)}KB)`);
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

  // Strip markdown fences
  if (result.startsWith("```")) {
    result = result.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  }

  return JSON.parse(result);
}

// ─── Claude API 호출 (텍스트) ───
async function callClaudeWithText(text) {
  console.log("🤖 Claude API 호출 중...");

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
      messages: [{ role: "user", content: text }],
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

// ─── MySQL 저장 ───
async function saveToDb(songId, melody) {
  const conn = await createConnection({
    host: process.env.DB_HOST || "localhost",
    port: parseInt(process.env.DB_PORT || "3306"),
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASS || "root",
    database: process.env.DB_NAME || "ccmdb",
  });

  const sectionsJson = JSON.stringify(melody.sections || []);
  const measuresJson = JSON.stringify(melody.measures || []);
  const key = melody.key || "C";
  const timeSignature = melody.timeSignature || "4/4";

  // Check if song exists
  const [songs] = await conn.execute("SELECT id FROM songs WHERE id = ?", [songId]);
  if (songs.length === 0) {
    await conn.end();
    throw new Error(`Song ID ${songId} 가 songs 테이블에 존재하지 않습니다.`);
  }

  // Upsert
  const [existing] = await conn.execute(
    "SELECT id FROM song_melodies WHERE song_id = ?",
    [songId]
  );

  if (existing.length > 0) {
    await conn.execute(
      `UPDATE song_melodies
       SET melody_key = ?, time_signature = ?, sections_json = ?, measures_json = ?
       WHERE song_id = ?`,
      [key, timeSignature, sectionsJson, measuresJson, songId]
    );
    console.log(`✅ Song ${songId} 멜로디 업데이트 완료`);
  } else {
    await conn.execute(
      `INSERT INTO song_melodies (song_id, melody_key, time_signature, sections_json, measures_json)
       VALUES (?, ?, ?, ?, ?)`,
      [songId, key, timeSignature, sectionsJson, measuresJson]
    );
    console.log(`✅ Song ${songId} 멜로디 삽입 완료`);
  }

  // Print summary
  console.log(`   키: ${key}, 박자: ${timeSignature}`);
  console.log(`   마디: ${melody.measures.length}개`);
  console.log(`   섹션: ${(melody.sections || []).map((s) => s.label).join(", ") || "없음"}`);

  if (melody.title) console.log(`   제목: ${melody.title}`);
  if (melody.artist) console.log(`   아티스트: ${melody.artist}`);

  // Print first few measures for verification
  const totalNotes = melody.measures.reduce((s, m) => s + m.notes.length, 0);
  console.log(`   총 음표: ${totalNotes}개`);

  await conn.end();
}

// ─── 메인 ───
async function main() {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.log(`
사용법:
  node parse-melody.mjs <songId> <악보이미지>        # 이미지 파일
  node parse-melody.mjs <songId> <img1> <img2> ...   # 여러 장 (페이지순)
  node parse-melody.mjs <songId> <텍스트파일.txt>     # 텍스트 입력도 가능

지원 이미지: PNG, JPG, JPEG, GIF, WEBP

예시:
  node parse-melody.mjs 1 samples/song1.png
  node parse-melody.mjs 2 samples/page1.jpg samples/page2.jpg
  node parse-melody.mjs 3 samples/song3.txt

여러 곡 한번에:
  for f in samples/*.png; do
    id=\$(basename "$f" .png | sed 's/song//')
    node parse-melody.mjs "$id" "$f"
  done
`);
    process.exit(1);
  }

  const songId = parseInt(args[0]);
  if (isNaN(songId)) {
    console.error("❌ songId는 숫자여야 합니다.");
    process.exit(1);
  }

  const inputFiles = args.slice(1);

  // Determine if image or text input
  const allImages = inputFiles.every(isImageFile);
  const firstIsText = !isImageFile(inputFiles[0]);

  console.log(`\n🎵 Song ${songId} 악보 파싱 시작`);

  let melody;

  if (allImages) {
    // Image mode
    console.log(`   입력: 이미지 ${inputFiles.length}장\n`);
    melody = await callClaudeWithImages(inputFiles);
  } else if (firstIsText && inputFiles.length === 1) {
    // Text mode (backward compatible)
    let text;
    if (inputFiles[0] === "--stdin") {
      text = readFileSync("/dev/stdin", "utf-8");
    } else {
      text = readFileSync(inputFiles[0], "utf-8");
    }
    if (!text.trim()) {
      console.error("❌ 입력 텍스트가 비어있습니다.");
      process.exit(1);
    }
    console.log(`   입력: 텍스트 ${text.split("\n").length}줄\n`);
    melody = await callClaudeWithText(text);
  } else {
    console.error("❌ 이미지 파일과 텍스트 파일을 섞어서 입력할 수 없습니다.");
    process.exit(1);
  }

  // JSON 파일로도 저장 (백업)
  const outPath = `output/song${songId}.json`;
  const { mkdirSync, writeFileSync } = await import("fs");
  mkdirSync("output", { recursive: true });
  writeFileSync(outPath, JSON.stringify(melody, null, 2));
  console.log(`\n💾 JSON 백업: ${outPath}`);

  // DB 저장
  await saveToDb(songId, melody);
}

main().catch((err) => {
  console.error(`\n❌ 오류: ${err.message}`);
  process.exit(1);
});
