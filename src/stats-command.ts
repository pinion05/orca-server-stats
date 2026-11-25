// The command the remote mode runs in a terminal on the measured machine. It is a POSIX sh script
// that calls nothing but `sleep`, and `nvidia-smi` where there is one, and prints one JSON line per
// sample and nothing else, so a reading is one line of that terminal's output. Sent as one line in
// single quotes, the script holds no single quote, and builds its own line marker from two pieces
// so that the command never contains it: a line of output is told apart from everything else by
// that marker.

/** The title of the terminal the plugin opens on the measured machine. */
export const STATS_TITLE = 'orca-server-stats'
/** What every line of the script starts with; the JSON follows it. */
export const STATS_MARKER = 'orca-server-stats '

/** What a reading may ask of the script: whole seconds only, so nothing but a number gets into it. */
export type StatsCommandOptions = {
  /** How often the plugin reads. The script samples several times per reading, so none is old. */
  readonly refreshSeconds: number
}

/** The script samples at least this often, whatever the reading interval. */
const SAMPLE_SECONDS_MAX = 5

/**
 * `exec sh -c '…'`: `exec` makes the terminal live exactly as long as the script, so a script
 * that dies takes its terminal with it instead of leaving a silent prompt behind.
 */
export function statsCommand(options: StatsCommandOptions): string {
  const sampleSeconds = sampleSecondsFor(options.refreshSeconds)
  const gpuEvery = Math.max(1, Math.round(GPU_SECONDS_BETWEEN / sampleSeconds))
  const script = [
    // A sample is numbered from 1, so a reader can tell a new line from one it has seen.
    'sq=0',
    // CPU ticks at the previous sample, total and busy; empty until the first sample.
    'pt=',
    'pb=',
    // The GPU fields from nvidia-smi's last answer, kept between its rare runs.
    'g=',
    'm="orca-server-"',
    'm="${m}stats "',
    // A newline and a carriage return, for cutting multi-line and Windows-style output.
    'nl=$(printf "\\nx")',
    'nl=${nl%x}',
    'cr=$(printf "\\rx")',
    'cr=${cr%x}',
    // Sets ct (ticks since boot) and cb (busy ones), or fails when there is no such counter.
    'cpu() { u=; ni=; sy=; id=; io=; ir=; sr=; st=; if [ -r /proc/stat ]; then read -r _ u ni sy id io ir sr st _ < /proc/stat; fi; case "$u" in ""|*[!0-9]*) return 1;; esac; ct=$((u + ni + sy + id + io + ir + sr + st)); cb=$((ct - id - io)); }',
    // nvidia-smi, the one command the script runs, is given five seconds. A call that hangs, as a
    // wedged driver's does, is killed and answers 124: the GPU is left out of that reading and asked
    // for ten times less often, and the rest of the reading is not held up for good.
    'ask() { ( exec nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits 2>/dev/null ) & p=$!; n=0; while [ $n -lt 5 ] && kill -0 $p 2>/dev/null; do sleep 1; n=$((n + 1)); done; if kill -0 $p 2>/dev/null; then kill -9 $p 2>/dev/null; wait $p 2>/dev/null; return 124; fi; wait $p 2>/dev/null; }',
    // The first GPU nvidia-smi reports, from its first line. A slow nvidia-smi is asked ten times less often.
    'gpu() { s0=; if [ -r /proc/uptime ]; then read -r s0 _ < /proc/uptime; fi; o=$(ask); r=$?; if [ $r -ne 0 ]; then g=; if [ $r -eq 124 ]; then k=$((k * 10)); fi; return 0; fi; o=${o%%"$nl"*}; o=${o%"$cr"}; if [ -n "$s0" ] && [ -r /proc/uptime ]; then read -r s1 _ < /proc/uptime; if [ -n "$s1" ] && [ $((${s1%.*} - ${s0%.*})) -gt 2 ]; then k=$((k * 10)); fi; fi; g=$(IFS=,; set -f; set -- $o; case "$1" in ""|*[!A-Za-z0-9_.+\\ -]*) exit 0;; esac; [ -n "${2:-}" ] && [ -n "${3:-}" ] && [ -n "${4:-}" ] || exit 0; case "${2}${3}${4}" in *[!0-9\\ ]*) exit 0;; esac; printf ",\\"gpu\\":\\"%s\\",\\"gu\\":%s,\\"vu\\":%s,\\"vt\\":%s" "$1" "$(($2))" "$(($3))" "$(($4))"); }',
    // The CPU model, read once; dropped unless it is plain words, so it needs no JSON escaping.
    // A case pattern ends at a bracket it does not know about: its parentheses and its space are escaped.
    'cm=',
    'if [ -r /proc/cpuinfo ]; then while read -r cl; do case "${cl%%:*}" in "model name"*) cm=${cl#*:}; cm=${cm# };; esac; [ -n "$cm" ] && break; done < /proc/cpuinfo; fi',
    'case "$cm" in ""|*[!A-Za-z0-9_.+\\(\\)/=@:\\ -]*|*\\\\*) cm=;; esac',
    // Sets j to the JSON of one sample, with every metric the machine could not report left out.
    'line() { j="{\\"v\\":1,\\"seq\\":$sq"; if cpu; then if [ -n "$pt" ] && [ "$ct" -gt "$pt" ]; then j="$j,\\"cpu\\":$(((cb - pb) * 1000 / (ct - pt)))"; fi; pt=$ct; pb=$cb; nc=0; while read -r cx _; do case "$cx" in cpu[0-9]*) nc=$((nc + 1));; esac; done < /proc/stat; j="$j,\\"cores\\":$nc"; fi; mt=; ma=; if [ -r /proc/meminfo ]; then while read -r mk mv _; do case "$mk" in MemTotal:) mt=$mv;; MemAvailable:) ma=$mv;; esac; done < /proc/meminfo; fi; if [ -n "$mt" ] && [ -n "$ma" ]; then j="$j,\\"mem\\":[$mt,$((mt - ma))]"; fi; tz=; zc=0; for z in /sys/class/thermal/thermal_zone*; do [ -r "$z/temp" ] || continue; read -r tv < "$z/temp" || continue; case "$tv" in ""|*[!0-9]*) continue;; esac; ty=; if [ -r "$z/type" ]; then read -r ty < "$z/type"; fi; case "$ty" in ""|*[!A-Za-z0-9_.+-]*) ty=${z##*/};; esac; tz="$tz{\\"t\\":\\"$ty\\",\\"c\\":$tv},"; zc=$((zc + 1)); [ "$zc" -lt 24 ] || break; done; if [ -n "$tz" ]; then j="$j,\\"temp\\":[${tz%,}]"; fi; if [ -r /proc/loadavg ]; then read -r l1 l2 l3 _ < /proc/loadavg; case "$l1$l2$l3" in ""|*[!0-9.]*) ;; *) j="$j,\\"load\\":\\"$l1 $l2 $l3\\"";; esac; fi; if [ -r /proc/uptime ]; then read -r up _ < /proc/uptime; case "$up" in ""|*[!0-9.]*) ;; *) j="$j,\\"up\\":$up";; esac; fi; if [ -n "$cm" ]; then j="$j,\\"model\\":\\"$cm\\""; fi; if [ $((sq % k)) -eq 1 ] && command -v nvidia-smi > /dev/null 2>&1; then gpu; fi; if [ -n "$g" ]; then j="$j$g"; fi; }',
    // A first CPU reading needs a second sample a moment later.
    'cpu',
    'pt=$ct',
    'pb=$cb',
    'sleep 1',
    `i=${sampleSeconds}`,
    `k=${gpuEvery}`,
    'while :; do sq=$((sq + 1)); line; printf "%s\\n" "$m$j}"; sleep "$i"; done'
  ]
  return `exec sh -c '${script.join('; ')}'`
}

/** How many seconds between nvidia-smi runs, the one costly read on the measured machine. */
const GPU_SECONDS_BETWEEN = 30

/** The script's own period: a third of the reading interval at most, and never more than five seconds. */
export function sampleSecondsFor(refreshSeconds: number): number {
  const seconds = Number.isFinite(refreshSeconds) ? Math.min(60, Math.max(1, Math.round(refreshSeconds))) : 2
  return Math.max(1, Math.min(SAMPLE_SECONDS_MAX, Math.floor(seconds / 3)))
}
