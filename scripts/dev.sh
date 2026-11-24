#!/usr/bin/env bash
# Sobe ou derruba a aplicação local: Postgres do projeto, reranker, API, worker e chat.
# Redis e Ollama só são iniciados se estiverem parados, e não são encerrados no down.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
RUN="$ROOT/.data/run"
mkdir -p "$RUN"

PG_PORT=54329
API_PORT=4000
WEB_PORT=3000
RERANK_PORT=8080
REDIS_PORT=6379
OLLAMA_URL="http://127.0.0.1:11434/api/version"
RERANK_MODEL="$ROOT/.data/models/bge-reranker-v2-m3-FP16.gguf"

log() { printf '%s\n' "$*"; }
die() { printf '%s\n' "$*" >&2; exit 1; }

listen() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
}

pg_ctl_bin() {
  if [[ -x /opt/homebrew/opt/postgresql@17/bin/pg_ctl ]]; then
    echo /opt/homebrew/opt/postgresql@17/bin/pg_ctl
    return
  fi
  local prefix
  prefix="$(brew --prefix postgresql@17 2>/dev/null || true)"
  [[ -n "$prefix" && -x "$prefix/bin/pg_ctl" ]] || die "PostgreSQL 17 não encontrado. Instale com: brew install postgresql@17"
  echo "$prefix/bin/pg_ctl"
}

pid_alive() {
  local file="$1"
  [[ -f "$file" ]] || return 1
  local pid
  pid="$(<"$file")"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

# O tsx e o Next soltam a porta ao recarregar. O processo pai continua vivo; a porta, não.
service_up() {
  local name="$1"
  local port="$2"
  if [[ -f "$RUN/$name.pid" ]]; then
    pid_alive "$RUN/$name.pid"
    return
  fi
  listen "$port"
}

kill_tree() {
  local pid="$1"
  local child
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do
    kill_tree "$child"
  done
  kill "$pid" 2>/dev/null || true
}

stop_recorded() {
  local name="$1"
  local file="$RUN/$name.pid"
  if pid_alive "$file"; then
    kill_tree "$(<"$file")"
    log "$name encerrado"
  fi
  rm -f "$file"
}

start_logged() {
  local name="$1"
  shift
  if pid_alive "$RUN/$name.pid"; then
    log "$name já está em execução"
    return 0
  fi
  : >"$RUN/$name.log"
  nohup "$@" >>"$RUN/$name.log" 2>&1 &
  echo $! >"$RUN/$name.pid"
  disown || true
  log "$name iniciado"
}

wait_http() {
  local url="$1"
  local label="$2"
  local i
  for i in $(seq 1 40); do
    if curl -sf -m 2 -o /dev/null "$url"; then
      log "$label respondeu"
      return 0
    fi
    sleep 1
  done
  die "$label não respondeu em $url. Veja os logs em .data/run/"
}

start_postgres() {
  if listen "$PG_PORT"; then
    log "Postgres já está na porta $PG_PORT"
    return 0
  fi
  [[ -d "$ROOT/.data/pg" ]] || die "Cluster do projeto ausente em .data/pg"
  local ctl
  ctl="$(pg_ctl_bin)"
  "$ctl" -D "$ROOT/.data/pg" -o "-p $PG_PORT -k /tmp" -l "$ROOT/.data/pg.log" start
  log "Postgres iniciado na porta $PG_PORT"
}

stop_postgres() {
  if [[ ! -f "$ROOT/.data/pg/postmaster.pid" ]]; then
    return 0
  fi
  local ctl
  ctl="$(pg_ctl_bin)"
  "$ctl" -D "$ROOT/.data/pg" stop -m fast
  log "Postgres do projeto encerrado"
}

start_redis() {
  if listen "$REDIS_PORT"; then
    log "Redis já está na porta $REDIS_PORT"
    return 0
  fi
  command -v redis-server >/dev/null || die "Redis não encontrado. Instale com: brew install redis"
  redis-server --daemonize yes --port "$REDIS_PORT" --dir "$RUN" --dbfilename dump.rdb \
    --pidfile "$RUN/redis.pid" --logfile "$RUN/redis.log"
  echo started >"$RUN/redis.by-script"
  log "Redis iniciado na porta $REDIS_PORT"
}

stop_redis_if_ours() {
  if [[ -f "$RUN/redis.by-script" ]] && [[ -f "$RUN/redis.pid" ]]; then
    redis-cli -p "$REDIS_PORT" shutdown nosave >/dev/null 2>&1 || true
    rm -f "$RUN/redis.pid" "$RUN/redis.by-script"
    log "Redis iniciado por este script foi encerrado"
  fi
}

start_ollama() {
  if curl -sf -m 2 -o /dev/null "$OLLAMA_URL"; then
    log "Ollama já está em execução"
    return 0
  fi
  command -v open >/dev/null || die "Ollama parado e o comando open não está disponível"
  open -a Ollama
  local i
  for i in $(seq 1 30); do
    if curl -sf -m 2 -o /dev/null "$OLLAMA_URL"; then
      log "Ollama iniciado"
      return 0
    fi
    sleep 1
  done
  die "Ollama não respondeu em $OLLAMA_URL"
}

start_reranker() {
  if listen "$RERANK_PORT"; then
    log "Reranker já está na porta $RERANK_PORT"
    return 0
  fi
  [[ -f "$RERANK_MODEL" ]] || die "Modelo do reranker ausente. Rode: npm run reranker:download"
  command -v llama-server >/dev/null || die "llama-server não encontrado"
  start_logged reranker llama-server -m "$RERANK_MODEL" --reranking \
    --host 127.0.0.1 --port "$RERANK_PORT" -c 8192 -np 4 -b 2048 -ub 2048 -ngl 99 --no-webui
}

start_web() {
  if listen "$WEB_PORT"; then
    log "Chat já está na porta $WEB_PORT"
    return 0
  fi
  start_logged web npm run dev:web
  local i
  for i in $(seq 1 15); do
    if listen "$WEB_PORT"; then
      return 0
    fi
    if ! pid_alive "$RUN/web.pid"; then
      if grep -q "Retry the same command" "$RUN/web.log"; then
        log "Next.js interrompeu na primeira abertura. Subindo o chat de novo."
        start_logged web npm run dev:web
        return 0
      fi
      die "O chat encerrou. Veja .data/run/web.log"
    fi
    sleep 1
  done
}

worker_running() {
  pid_alive "$RUN/worker.pid" && return 0
  local pid cwd
  for pid in $(pgrep -f "tsx watch --clear-screen=false src/main.ts" 2>/dev/null || true); do
    cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | awk '/^n/ { print substr($0, 2); exit }')"
    if [[ "$cwd" == "$ROOT/apps/worker" || "$cwd" == "$ROOT" ]]; then
      return 0
    fi
  done
  return 1
}

cmd_up() {
  start_postgres
  start_redis
  start_ollama
  start_reranker
  if listen "$API_PORT"; then
    log "API já está na porta $API_PORT"
  else
    start_logged api npm run dev:api
  fi
  if worker_running; then
    log "Worker já está em execução"
  else
    start_logged worker npm run dev:worker
  fi
  start_web
  wait_http "http://127.0.0.1:$API_PORT/health" "API"
  wait_http "http://127.0.0.1:$RERANK_PORT/health" "Reranker"
  wait_http "http://127.0.0.1:$WEB_PORT/chat" "Chat"
  hold_terminal
}

# Segura o terminal que subiu a aplicação. Prompt livre significa que ela não está no ar.
hold_terminal() {
  local supervisor="$RUN/supervisor.pid"
  if pid_alive "$supervisor"; then
    log "A aplicação já está no ar, no terminal que rodou npm run dev:up."
    log "Para encerrar: Ctrl+C nesse terminal, ou npm run dev:down."
    return 0
  fi
  echo $$ >"$supervisor"
  log "Aplicação no ar: http://127.0.0.1:$WEB_PORT"
  log "Este terminal fica ocupado enquanto ela estiver rodando. Ctrl+C encerra."

  release() {
    trap - INT TERM HUP
    cmd_down
    rm -f "$supervisor"
    exit 0
  }
  trap release INT TERM HUP

  local down=0
  while true; do
    sleep 2
    if service_up api "$API_PORT" && service_up web "$WEB_PORT"; then
      down=0
      continue
    fi
    down=$((down + 1))
    if (( down < 3 )); then
      continue
    fi
    trap - INT TERM HUP
    log "A aplicação parou. Encerrando o que ainda estiver no ar."
    cmd_down
    rm -f "$supervisor"
    exit 0
  done
}

cmd_down() {
  stop_recorded web
  stop_recorded api
  stop_recorded worker
  stop_recorded reranker
  stop_postgres
  stop_redis_if_ours
  log "Aplicação encerrada. Redis e Ollama que já estavam no ar foram mantidos."
}

cmd_status() {
  listen "$PG_PORT" && log "Postgres: no ar ($PG_PORT)" || log "Postgres: parado"
  listen "$REDIS_PORT" && log "Redis: no ar ($REDIS_PORT)" || log "Redis: parado"
  curl -sf -m 2 -o /dev/null "$OLLAMA_URL" && log "Ollama: no ar" || log "Ollama: parado"
  listen "$RERANK_PORT" && log "Reranker: no ar ($RERANK_PORT)" || log "Reranker: parado"
  listen "$API_PORT" && log "API: no ar ($API_PORT)" || log "API: parado"
  worker_running && log "Worker: no ar" || log "Worker: parado"
  listen "$WEB_PORT" && log "Chat: no ar (http://127.0.0.1:$WEB_PORT)" || log "Chat: parado"
}

case "${1:-up}" in
  up) cmd_up ;;
  down) cmd_down ;;
  status) cmd_status ;;
  *) die "Uso: scripts/dev.sh [up|down|status]" ;;
esac
