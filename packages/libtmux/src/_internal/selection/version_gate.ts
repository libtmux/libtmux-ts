import {
  WHERE_FIELDS_V1,
  WHERE_RELATIONS_V1,
  type WhereModel,
} from "../../_generated/where_fields.js";
import { VersionTooLow } from "../../exc.js";
import { compareTmuxVersions, parseTmuxVersion } from "../runtime/tmux_version.js";

/** Refuse criteria that the captured tmux version could not have answered. */
export function refuseFieldsNewerThanServer(
  model: WhereModel,
  query: Readonly<Record<string, unknown>>,
  serverVersion: string | undefined,
): void {
  // Stored graphs from before version evidence cannot support this distinction.
  if (serverVersion === undefined) return;
  const actual = parseTmuxVersion(serverVersion);

  const walk = (scope: WhereModel, node: Readonly<Record<string, unknown>>): void => {
    const relations = WHERE_RELATIONS_V1[scope];
    for (const [key, value] of Object.entries(node)) {
      if (key === "AND" || key === "OR" || key === "NOT") {
        for (const branch of value as readonly Readonly<Record<string, unknown>>[]) {
          walk(scope, branch);
        }
        continue;
      }
      const relation = relations.find((candidate) => candidate.name === key);
      if (relation !== undefined) {
        for (const quantified of Object.values(value as Readonly<Record<string, unknown>>)) {
          if (quantified !== null) {
            walk(relation.targetModel, quantified as Readonly<Record<string, unknown>>);
          }
        }
        continue;
      }
      const field = WHERE_FIELDS_V1[scope].find((candidate) => candidate.wireName === key);
      if (field === undefined) continue;
      if (compareTmuxVersions(actual, parseTmuxVersion(field.since)) >= 0) continue;
      throw new VersionTooLow({
        criteriaName: field.criteriaName,
        serverVersion,
        since: field.since,
      });
    }
  };
  walk(model, query);
}
