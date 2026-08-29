import { randomUUID } from "node:crypto";

/**
 * Build one shell input line whose optional leading space suppresses history.
 * The wrapper removes its parsed release marker before command evaluation.
 */
export function frame(command: string, ready: string, suppressHistory: boolean): string {
  const prefix = suppressHistory ? " " : "";
  const scope = `__ltx_${randomId()}`;
  const marker = `${scope}_marker`;
  const markerPattern = `ltx${"[0-9a-f]".repeat(10)}`;
  const options = `${scope}_options`;
  const payload = `${scope}_payload`;
  const traps = `${scope}_traps`;
  const normalized = command.replace(/\r\n?/gu, "\n");
  if (normalized.includes("\0")) throw new TypeError("command must not contain NUL bytes");
  const encoded = [...Buffer.from(normalized, "utf8")]
    .map((byte) => `\\0${byte.toString(8).padStart(3, "0")}`)
    .join("");
  return (
    `${prefix}( ${options}=$-; set +x; set +e; ${traps}=; ` +
    `case "\${BASH_VERSION-}" in ?*) ${traps}=$(trap -p DEBUG RETURN ERR); ` +
    `set +T; trap - DEBUG RETURN ERR;; esac; ` +
    `case "\${ZSH_VERSION-}" in ?*) ${traps}=$(typeset -f TRAPDEBUG); ` +
    `unfunction TRAPDEBUG 2>/dev/null || :;; esac; ` +
    `${payload}=$(printf '%bX' '${encoded}'); ${payload}=\${${payload}%X}; ` +
    `printf '%s%s\\n' '${ready}' '_R'; ` +
    `while IFS= read -r ${marker}; do ` +
    `case "\${${marker}}" in ${markerPattern}) break;; esac; done; ` +
    `case "\${${marker}}" in ${markerPattern}) :;; *) exit 125;; esac; ` +
    `${scope}() { printf '%s\\n' "\${${marker}}_S"; ` +
    `( unset ${marker}; set --; ` +
    `eval "\${${traps}}"; unset ${traps}; ` +
    `case "\${BASH_VERSION-}:\${${options}}" in ?*:*T*) set -T;; esac; ` +
    `case "\${${options}}" in *e*) set -e;; esac; ` +
    `case "\${${options}}" in *x*) set -x;; esac; ` +
    `unset ${options}; eval "\${${payload}}" ); ` +
    `printf '%s %s %s\\n' "\${${marker}}_E" "$?" "\${${marker}}_D"; }; ${scope} )`
  );
}

/** A framing marker: `<id>_S` or `<id>_E`, as the shell prints it. */
const MARKER = /\b(ltx[0-9a-f]+)_([SE])\b/u;
/** A framing command, as the pane echoes it back when somebody types one. */
const FRAMING_ECHO = /(?:^|\s)__ltx_[0-9a-f]+\(\)/u;

/**
 * Remove another caller's framing, and its output, from this caller's body.
 *
 * Ids are unique, so no run ever matches another's markers — but the body
 * between one run's markers is everything the pane printed meanwhile, which on
 * a shared pane includes a second caller's echoed command and its output. That
 * is not noise: a command carries whatever the other agent put in it, so the
 * result of one call disclosed the input of another. Every agent CLI on a
 * machine can point at one server, which makes two callers on one pane the
 * ordinary case rather than a contrived one.
 *
 * A pane is single-writer and nothing here can lock it across processes, so
 * this cleans the report rather than preventing the overlap — and it cannot
 * clean all of it. A foreign run that started before this one and printed
 * during it leaves output with no marker anywhere in this body, textually
 * indistinguishable from this command's own; a foreign run still going when
 * this one ends leaves output that cannot be bracketed. Dropping to the end of
 * the body on an unterminated marker would take this caller's real output with
 * it, so the choice is between silently returning someone else's output and
 * silently returning a hole. It reports instead: `foreignOutputSuspected` says
 * another writer was seen in this body. False is not proof of cleanliness —
 * only that no foreign marker appeared here.
 */
export function withoutForeignFraming(
  body: string,
  id: string,
): { readonly foreignOutputSuspected: boolean; readonly text: string } {
  const lines = body.split("\n");
  const foreign = (value: string): boolean => value !== id;

  // A foreign run whose start and end are both here brackets that run's own
  // output, which belongs to its caller. An unterminated one is left alone:
  // dropping to the end of the body would take this caller's output with it.
  const drop = new Set<number>();
  for (const [index, line] of lines.entries()) {
    const start = MARKER.exec(line);
    if (start?.[2] !== "S" || !foreign(start[1] ?? "")) continue;
    const closes = lines.findIndex(
      (later, at) => at > index && later.includes(`${start[1] ?? ""}_E`),
    );
    if (closes < 0) continue;
    for (let at = index; at <= closes; at += 1) drop.add(at);
  }

  let seen = drop.size > 0;
  const kept = lines.filter((line, index) => {
    if (drop.has(index)) return false;
    const echo = FRAMING_ECHO.exec(line);
    if (echo !== null) {
      seen = true;
      return false;
    }
    const marker = MARKER.exec(line);
    if (marker !== null && foreign(marker[1] ?? "")) {
      seen = true;
      return false;
    }
    return true;
  });

  return { foreignOutputSuspected: seen, text: kept.join("\n") };
}

export interface ParsedFramedOutput {
  readonly exitStatus: number;
  readonly foreignOutputSuspected: boolean;
  readonly output: string;
  readonly outputComplete: boolean;
}

/**
 * Pull the command's own output out of the framed stream.
 *
 * The end marker carries the status; its matching done marker proves the
 * status arrived whole. The random value is unavailable through the command's
 * inherited shell state; this is framing, not a sandbox against code that can
 * inspect the tmux server itself.
 * The start marker is only needed to locate where the body begins — and it is
 * printed first, so it is the first thing lost, whether to the tail's byte
 * limit or to a fallback capture that samples the last few hundred lines.
 * Requiring it meant a command that outran either bound ran to its deadline and
 * was reported as still running after it had already finished, which is worse
 * than reporting it finished with output that starts partway through.
 */
export function parseFramedOutput(stream: string, id: string): ParsedFramedOutput | undefined {
  const startAt = stream.indexOf(`${id}_S`);
  const endPrefix = `${id}_E `;
  const endSuffix = ` ${id}_D`;
  let endAt = stream.indexOf(endPrefix, startAt < 0 ? 0 : startAt);
  let exitStatus: number | undefined;
  while (endAt >= 0) {
    const suffixAt = stream.indexOf(endSuffix, endAt + endPrefix.length);
    if (suffixAt < 0) return undefined;
    const rawStatus = stream.slice(endAt + endPrefix.length, suffixAt);
    const parsed = Number(rawStatus);
    const afterSuffix = stream[suffixAt + endSuffix.length];
    const completeSuffix =
      afterSuffix === undefined ||
      afterSuffix === "\n" ||
      (afterSuffix === "\r" && stream[suffixAt + endSuffix.length + 1] === "\n");
    if (/^(?:0|[1-9][0-9]{0,2})$/u.test(rawStatus) && parsed <= 255 && completeSuffix) {
      exitStatus = parsed;
      break;
    }
    endAt = stream.indexOf(endPrefix, endAt + endPrefix.length);
  }
  if (endAt < 0 || exitStatus === undefined) return undefined;

  // With the start marker gone, the retained buffer opens partway through the
  // command's own output, so that is where the body begins.
  const afterStart = startAt < 0 ? 0 : stream.indexOf("\n", startAt) + 1;
  const body =
    startAt >= 0 && (afterStart === 0 || afterStart > endAt) ? "" : stream.slice(afterStart, endAt);

  // Remove one line break before the marker and normalize the pty's CRLF.
  const cleaned = withoutForeignFraming(body.replace(/\r?\n?$/, "").replaceAll("\r\n", "\n"), id);

  return {
    exitStatus,
    foreignOutputSuspected: cleaned.foreignOutputSuspected,
    output: cleaned.text,
    outputComplete: startAt >= 0,
  };
}

/** An alphanumeric marker line that every supported shell reads without interpretation. */
export function randomId(): string {
  return randomUUID().replaceAll("-", "").slice(0, 10);
}
