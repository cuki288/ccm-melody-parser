# CCM Melody Parser

CCM(찬양) 악보의 코드+가사 텍스트를 AI(Claude)로 분석하여 JSON 멜로디 데이터로 변환하고, MySQL DB에 직접 저장하는 CLI 도구입니다.

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
# 기본 사용
export ANTHROPIC_API_KEY=sk-ant-...
node parse-melody.mjs <songId> <inputFile>

# 예시
node parse-melody.mjs 1 samples/example.txt

# stdin으로 입력
echo "코드+가사 텍스트" | node parse-melody.mjs 1 --stdin

# 여러 곡 한번에
for f in samples/*.txt; do
  id=$(basename "$f" .txt | sed 's/song//')
  node parse-melody.mjs "$id" "$f"
done
```

## 입력 형식

```
[1절]
G        D/F#     Em
주님의 사랑이 나를 감싸네
C        G/B      Am7  D
그 크신 은혜가 나를 품으셨네

[후렴]
G        D        Em       C
할렐루야 찬양해 주님만이 나의 전부
```

## 출력 형식 (JSON)

```json
{
  "key": "G",
  "timeSignature": "4/4",
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
