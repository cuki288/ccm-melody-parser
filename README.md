# CCM Melody Parser

CCM(찬양) **악보 사진**을 AI(Claude Vision)로 분석하여 음높이·박자·코드·가사를 자동 추출하고, JSON 멜로디 데이터로 변환하여 MySQL DB에 직접 저장하는 CLI 도구입니다.

## 설치

```bash
npm install
```

## 환경변수

| 변수 | 설명 | 기본값 |
|------|------|--------|
| `ANTHROPIC_API_KEY` | Claude API 키 (필수) | - |
| `DB_HOST` | MySQL 호스트 | localhost |
| `DB_PORT` | MySQL 포트 | 3306 |
| `DB_USER` | MySQL 사용자 | root |
| `DB_PASS` | MySQL 비밀번호 | root |
| `DB_NAME` | MySQL DB명 | ccmdb |

## 사용법

```bash
export ANTHROPIC_API_KEY=sk-ant-...

# 악보 사진 1장
node parse-melody.mjs <songId> <악보이미지.png>

# 악보 사진 여러 장 (페이지 순서대로)
node parse-melody.mjs <songId> page1.jpg page2.jpg page3.jpg

# 텍스트 입력도 가능 (하위 호환)
node parse-melody.mjs <songId> song.txt
```

### 예시

```bash
# 단일 이미지
node parse-melody.mjs 1 samples/song1.png

# 여러 페이지 악보
node parse-melody.mjs 2 samples/page1.jpg samples/page2.jpg

# 여러 곡 한번에
for f in samples/*.png; do
  id=$(basename "$f" .png | sed 's/song//')
  node parse-melody.mjs "$id" "$f"
done
```

## 지원 이미지 형식

PNG, JPG, JPEG, GIF, WEBP

## 동작 순서

1. 악보 이미지를 읽어 base64로 인코딩
2. Claude Vision API에 전송
3. AI가 오선보를 읽고 모든 음표의 음높이·박자·가사·코드를 추출
4. JSON 멜로디 데이터로 변환
5. `output/songN.json`에 JSON 백업 저장
6. MySQL DB(`song_melodies` 테이블)에 INSERT/UPDATE

## AI가 읽는 정보

- **음높이**: 오선보 위치 + 조표(#, b) + 임시표 반영 → C4, D#4, Bb4 등
- **박자**: 음표 모양(온음표, 2분, 4분, 8분, 16분, 점음표, 타이) → 4, 2, 1, 0.5, 0.25 등
- **코드**: 악보 위 코드 기호 → G, D/F#, Am7 등
- **가사**: 음표 아래 한글 가사 → 음절 단위
- **섹션**: 1절, 후렴, 브릿지 등 구분
- **반복**: 반복 기호(𝄆) → 펼쳐서 포함
- **쉼표**: 쉼표도 음표로 처리 (p: "R")

## 출력 형식 (JSON)

```json
{
  "title": "주님의 사랑이",
  "artist": "작곡가",
  "key": "G",
  "timeSignature": "4/4",
  "tempo": 120,
  "sections": [
    {"measureIndex": 0, "label": "1절"},
    {"measureIndex": 4, "label": "후렴"}
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
```

## 관련 프로젝트

- [CCM Conti Maker](https://github.com/cuki288/ccmcontimaker) - CCM 콘티 메이커 웹 앱
