#!/usr/bin/env node
/**
 * AI 악보 파싱 스크립트
 *
 * 사용법:
 *   node scripts/parse-melody.mjs <songId> <inputFile>
 *   node scripts/parse-melody.mjs 1 scripts/samples/song1.txt
 *   echo "텍스트" | node scripts/parse-melody.mjs 1 --stdin
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
import { createConnection } from "mysql2/promise";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  console.error("❌ ANTHROPIC_API_KEY 환경변수를 설정하세요.");
  console.error("   export ANTHROPIC_API_KEY=sk-ant-...");
  process.exit(1);
}

const SYSTEM_PROMPT = `당신은 CCM(찬양) 악보를 분석하여 JSON 멜로디 데이터로 변환하는 전문가입니다.

## 입력 형식
입력은 3줄 단위로 구성됩니다:
1줄: 코드 (예: G  D/F#  Em)
2줄: 가사 (예: 주님의 사랑이 나를 감싸네)
3줄: 멜로디 음높이 (예: D4 D4 E4 G4 A4 G4 B4 A4 G4 A4 G4)

- 멜로디 줄의 각 음은 가사의 각 음절에 1:1 대응합니다
- 섹션 구분은 [1절], [후렴] 등으로 표시됩니다
- 멜로디 줄이 없으면 코드 진행을 기반으로 추정합니다

## 출력 형식
반드시 아래 JSON 형식으로만 응답하세요. 마크다운 코드 펜스나 설명 없이 순수 JSON만 반환하세요.

{
  "key": "G",
  "timeSignature": "4/4",
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
- p: 음높이 (예: C4, D#4, Bb4). 옥타브 포함. 쉼표는 "R"
- d: 박자 길이. 4분음표=1, 8분음표=0.5, 2분음표=2, 온음표=4, 점4분음표=1.5
- l: 가사 (한 음절). 가사가 없으면 이 필드 생략
- c: 코드 (예: G, D/F#, Am7). 코드가 바뀌는 음에만 표시, 나머지는 생략

## 규칙
1. 한 마디의 총 박자 합이 박자표에 맞아야 함 (4/4 → 4박, 3/4 → 3박, 6/8 → 3박)
2. 가사의 각 음절을 음표에 1:1 매핑
3. 멜로디 줄의 음높이를 그대로 "p" 필드에 사용 (절대 변경하지 말 것)
4. 코드는 해당 코드가 시작되는 첫 음에만 "c" 필드로 표시
5. 마디 구분은 가사의 흐름과 코드 진행으로 판단
6. 박자 길이(d)는 가사 흐름, 코드 변경 타이밍, 음절 수로 판단
7. 멜로디 줄이 없으면 가사와 코드 진행을 기반으로 합리적인 멜로디를 추정
8. 섹션 라벨: "1절", "2절", "후렴", "브릿지" 등 한글 사용
9. 입력의 키와 박자표를 분석해서 key, timeSignature도 반환

## 예시 (주님의 사랑이, G, 4/4)
입력:
[1절]
G        D/F#     Em
주님의 사랑이 나를 감싸네
D4 D4 E4 G4 A4 G4 B4 A4 G4 A4 G4
C        G/B      Am7  D
그 크신 은혜가 나를 품으셨네
E4 E4 D4 E4 G4 A4 B4 A4 G4 A4 F#4 G4

출력:
{"key":"G","timeSignature":"4/4","sections":[{"measureIndex":0,"label":"1절"}],"measures":[{"notes":[{"p":"D4","d":0.5,"l":"주","c":"G"},{"p":"D4","d":0.5,"l":"님"},{"p":"E4","d":1,"l":"의"},{"p":"G4","d":0.5,"l":"사","c":"D/F#"},{"p":"A4","d":0.5,"l":"랑"},{"p":"G4","d":1,"l":"이"}]},{"notes":[{"p":"B4","d":0.5,"l":"나","c":"Em"},{"p":"A4","d":0.5,"l":"를"},{"p":"G4","d":1,"l":"감"},{"p":"A4","d":1,"l":"싸"},{"p":"G4","d":1,"l":"네"}]},{"notes":[{"p":"E4","d":1,"l":"그","c":"C"},{"p":"E4","d":0.5,"l":"크"},{"p":"D4","d":0.5,"l":"신"},{"p":"E4","d":0.5,"l":"은","c":"G/B"},{"p":"G4","d":0.5,"l":"혜"},{"p":"A4","d":1,"l":"가"}]},{"notes":[{"p":"B4","d":0.5,"l":"나","c":"Am7"},{"p":"A4","d":0.5,"l":"를"},{"p":"G4","d":1,"l":"품"},{"p":"A4","d":0.5,"l":"으","c":"D"},{"p":"F#4","d":0.5,"l":"셨"},{"p":"G4","d":1,"l":"네"}]}]}`;

// ─── Claude API 호출 ───
async function callClaude(text) {
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
      max_tokens: 8192,
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

  // Strip markdown fences
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

  await conn.end();
}

// ─── 메인 ───
async function main() {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.log(`
사용법:
  node scripts/parse-melody.mjs <songId> <inputFile>
  node scripts/parse-melody.mjs <songId> --stdin

예시:
  node scripts/parse-melody.mjs 1 scripts/samples/song1.txt
  echo "악보 텍스트..." | node scripts/parse-melody.mjs 1 --stdin

여러 곡 한번에:
  for f in scripts/samples/*.txt; do
    id=$(basename "$f" .txt | sed 's/song//')
    node scripts/parse-melody.mjs "$id" "$f"
  done
`);
    process.exit(1);
  }

  const songId = parseInt(args[0]);
  if (isNaN(songId)) {
    console.error("❌ songId는 숫자여야 합니다.");
    process.exit(1);
  }

  let text;
  if (args[1] === "--stdin") {
    text = readFileSync("/dev/stdin", "utf-8");
  } else {
    text = readFileSync(args[1], "utf-8");
  }

  if (!text.trim()) {
    console.error("❌ 입력 텍스트가 비어있습니다.");
    process.exit(1);
  }

  console.log(`\n🎵 Song ${songId} 악보 파싱 시작`);
  console.log(`   입력: ${text.split("\n").length}줄\n`);

  // Claude로 파싱
  const melody = await callClaude(text);

  // JSON 파일로도 저장 (백업)
  const outPath = `scripts/output/song${songId}.json`;
  const { mkdirSync, writeFileSync } = await import("fs");
  mkdirSync("scripts/output", { recursive: true });
  writeFileSync(outPath, JSON.stringify(melody, null, 2));
  console.log(`💾 JSON 백업: ${outPath}`);

  // DB 저장
  await saveToDb(songId, melody);
}

main().catch((err) => {
  console.error(`\n❌ 오류: ${err.message}`);
  process.exit(1);
});
