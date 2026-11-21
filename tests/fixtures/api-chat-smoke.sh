#!/usr/bin/env bash
# Pergunta via SSE e verifica eventos, persistência da conversa e painel de fonte.
# Uso: bash tests/fixtures/api-chat-smoke.sh "pergunta" [credencial]
set -euo pipefail
B="${API_URL:-http://127.0.0.1:4000}/api"
T="$(grep '^ADMIN_API_TOKEN=' .env | cut -d= -f2-)"
Q="${1:-Qual o prazo para apresentação de defesa no procedimento disciplinar?}"
C="${2:-interno}"
H=(-H "authorization: Bearer $T" -H "x-rag-user-id: smoke-chat" -H "x-rag-clearance: $C")
OUT="$(mktemp)"; trap 'rm -f "$OUT"' EXIT

BODY="$(node -e 'process.stdout.write(JSON.stringify({content: process.argv[1]}))' "$Q")"
START=$(date +%s)
curl -sN "${H[@]}" -H "content-type: application/json" -d "$BODY" "$B/chat" > "$OUT"
echo "tempo total: $(( $(date +%s) - START ))s"
echo "eventos: $(grep '^event:' "$OUT" | sort | uniq -c | tr '\n' ' ')"

node - "$OUT" <<'EOF'
const fs = require('fs');
const events = fs.readFileSync(process.argv[2], 'utf8').split('\n\n').filter((b) => b.includes('data:'))
  .map((b) => JSON.parse(b.split('\n').find((l) => l.startsWith('data:')).slice(5)));
const done = events.find((e) => e.type === 'done');
const err = events.find((e) => e.type === 'error');
if (err) { console.log('ERRO:', err.code, err.message); process.exit(1); }
const m = done.message;
console.log('answerType:', m.answerType, '| status:', m.status);
console.log('fontes:', m.sources.length, '| citações:', m.citations.length);
console.log('resposta:\n' + m.content);
fs.writeFileSync(process.argv[2] + '.meta', JSON.stringify({ conv: events[0].conversationId, chunk: m.sources[0]?.chunkId ?? '' }));
EOF
META="$(cat "$OUT.meta")"; rm -f "$OUT.meta"
CONV="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).conv)' "$META")"
CHUNK="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).chunk)' "$META")"
echo "mensagens persistidas: $(curl -s "${H[@]}" "$B/conversations/$CONV/messages" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).items.map(m=>m.role+":"+m.status).join(", ")))')"
if [ -n "$CHUNK" ]; then
  echo "painel da fonte: $(curl -s "${H[@]}" "$B/sources/$CHUNK" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.document.documentNumber||j.document.title, "| págs", j.pages.map(p=>p.pageNumber).join(","))})')"
  echo "fonte com credencial publico: HTTP $(curl -s -o /dev/null -w '%{http_code}' -H "authorization: Bearer $T" -H "x-rag-user-id: smoke-chat" -H "x-rag-clearance: publico" "$B/sources/$CHUNK")"
fi
echo "conversa de outro usuário: HTTP $(curl -s -o /dev/null -w '%{http_code}' -H "authorization: Bearer $T" -H "x-rag-user-id: outro-usuario" "$B/conversations/$CONV/messages")"
curl -s -o /dev/null -X DELETE "${H[@]}" "$B/conversations/$CONV"
