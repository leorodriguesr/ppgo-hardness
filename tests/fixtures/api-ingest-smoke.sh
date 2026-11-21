#!/usr/bin/env bash
# Upload real -> processamento pelo worker -> pergunta sobre o conteúdo -> remoção.
set -euo pipefail
B="${API_URL:-http://127.0.0.1:4000}/api"
T="$(grep '^ADMIN_API_TOKEN=' .env | cut -d= -f2-)"
H=(-H "authorization: Bearer $T" -H "x-rag-user-id: smoke-ingest")
json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const f=new Function("j","return "+process.argv[1]);process.stdout.write(String(f(j)??""))})' "$1"; }
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
F="$TMP/instrucao-smoke.md"
N="$(( RANDOM % 900 + 100 ))"
cat > "$F" <<EOF
# Instrução Normativa nº ${N}/2026-SMOKE

Dispõe sobre o controle de chaves das guaritas.

## Do controle

Art. 1º As chaves das guaritas serão conferidas a cada troca de plantão pelo chefe de equipe.

Art. 2º O extravio de chave deverá ser comunicado à direção no prazo máximo de 2 (duas) horas.
EOF

M="{\"title\":\"Controle de chaves das guaritas\",\"documentNumber\":\"${N}/2026-SMOKE\",\"documentType\":\"instrucao_normativa\",\"accessLevel\":\"interno\",\"validityStatus\":\"vigente\"}"
RESP="$(curl -s "${H[@]}" -F "metadata=$M" -F "file=@$F" "$B/documents")"
DOC="$(printf '%s' "$RESP" | json 'j.documentId')"
[ -n "$DOC" ] || { echo "FAIL upload: $RESP"; exit 1; }
echo "upload aceito: $DOC"

STATUS=""
for _ in $(seq 1 90); do
  STATUS="$(curl -s "${H[@]}" "$B/documents/$DOC" | json 'j.versions?.[0]?.status')"
  case "$STATUS" in completed|failed) break ;; esac
  sleep 2
done
echo "status final: $STATUS"
echo "etapas registradas: $(curl -s "${H[@]}" "$B/documents/$DOC/events" | json 'j.items.reverse().map(e=>e.stage).filter((s,i,a)=>s!==a[i-1]).join(" > ")')"
echo "chunks: $(curl -s "${H[@]}" "$B/documents/$DOC/chunks" | json 'j.total ?? j.items.length')"
[ "$STATUS" = "completed" ] || { curl -s -o /dev/null -X DELETE "${H[@]}" "$B/documents/$DOC?hard=true"; exit 1; }

bash tests/fixtures/api-chat-smoke.sh "Qual o prazo para comunicar o extravio de chave da guarita?" interno | sed -n '1,8p'

echo "remoção: HTTP $(curl -s -o /dev/null -w '%{http_code}' -X DELETE "${H[@]}" "$B/documents/$DOC?hard=true")"
