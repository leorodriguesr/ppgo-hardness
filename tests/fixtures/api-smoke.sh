#!/usr/bin/env bash
# Verificações rápidas de autenticação/autorização contra uma API local em execução.
set -u
B="${API_URL:-http://127.0.0.1:4000}/api"
T="$(grep '^ADMIN_API_TOKEN=' .env | cut -d= -f2-)"
A=(-H "authorization: Bearer $T")
code() { curl -s -o /dev/null -w "%{http_code}" "$@"; }
check() { local label="$1" expected="$2"; shift 2; local got; got=$(code "$@"); if [ "$got" = "$expected" ]; then echo "OK   $label ($got)"; else echo "FAIL $label (esperado $expected, obtido $got)"; FAILED=1; fi; }
FAILED=0

check "sem token -> 401" 401 "$B/documents"
check "token inválido -> 401" 401 -H "authorization: Bearer xxxxxxxxxxxxxxxxxxxxxxxxxxxx" "$B/documents"
check "headers de identidade sem token -> 401" 401 -H "x-rag-roles: admin" "$B/documents"
check "listar documentos (admin) -> 200" 200 "${A[@]}" "$B/documents"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
F="$TMP/smoke-$(date +%s%N).md"
printf '# Nota de teste de fumaça\n\nDocumento temporário criado em %s para verificar upload e controle de acesso.\n' "$(date -u +%FT%T)" > "$F"

check "viewer não envia documento -> 403" 403 "${A[@]}" -H "x-rag-roles: viewer" -F "file=@$F" "$B/documents"
check "credencial interno não cria doc restrito -> 403" 403 "${A[@]}" -H "x-rag-clearance: interno" -F 'metadata={"title":"Teste de fumaça","accessLevel":"restrito"}' -F "file=@$F" "$B/documents"
RESP="$(curl -s "${A[@]}" -H "x-rag-clearance: restrito" -F 'metadata={"title":"Teste de fumaça","accessLevel":"restrito"}' -F "file=@$F" "$B/documents")"
DOC_ID="$(printf '%s' "$RESP" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(j.documentId??"")}catch{}})')"
if [ -n "$DOC_ID" ]; then echo "OK   upload admin aceito ($DOC_ID)"; else echo "FAIL upload admin: $RESP"; FAILED=1; fi
check "mesmo arquivo de novo -> 409 duplicado" 409 "${A[@]}" -F "file=@$F" "$B/documents"
DUP="$(curl -s "${A[@]}" -H "x-rag-clearance: interno" -F "file=@$F" "$B/documents")"
if printf '%s' "$DUP" | grep -q "$DOC_ID"; then echo "FAIL duplicata revelou id de doc restrito"; FAILED=1; else echo "OK   duplicata não revela id acima da credencial"; fi
check "extensão não permitida -> 415" 415 "${A[@]}" -F "file=@$F;filename=script.sh" "$B/documents"
if [ -n "$DOC_ID" ]; then
  check "credencial interno não vê doc restrito -> 404" 404 "${A[@]}" -H "x-rag-clearance: interno" "$B/documents/$DOC_ID"
  check "credencial restrito vê doc restrito -> 200" 200 "${A[@]}" -H "x-rag-clearance: restrito" "$B/documents/$DOC_ID"
  check "admin interno não rebaixa/edita acima da credencial -> 404" 404 "${A[@]}" -H "x-rag-clearance: interno" -X PATCH -H "content-type: application/json" -d '{"title":"x"}' "$B/documents/$DOC_ID"
  check "remoção definitiva -> 204" 204 "${A[@]}" -H "x-rag-clearance: restrito" -X DELETE "$B/documents/$DOC_ID?hard=true"
  check "após remoção -> 404" 404 "${A[@]}" -H "x-rag-clearance: restrito" "$B/documents/$DOC_ID"
fi
check "analyst não altera configurações -> 403" 403 "${A[@]}" -H "x-rag-roles: analyst" -X PUT -H "content-type: application/json" -d '{"settings":{},"expectedVersion":1}' "$B/settings"
check "viewer não lê métricas -> 403" 403 "${A[@]}" -H "x-rag-roles: viewer" "$B/metrics/dashboard"
check "viewer não lê auditoria -> 403" 403 "${A[@]}" -H "x-rag-roles: viewer" "$B/audit"
check "id inválido -> 400" 400 "${A[@]}" "$B/documents/nao-uuid"
check "rota inexistente -> 404" 404 "${A[@]}" "$B/inexistente"
check "role desconhecida -> 400" 400 "${A[@]}" -H "x-rag-roles: superuser" "$B/documents"
check "chat sem conteúdo -> 400" 400 "${A[@]}" -X POST -H "content-type: application/json" -d '{}' "$B/chat"
exit $FAILED
