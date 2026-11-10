// Fixed error codes and their CLI exit codes. The list is part of the public contract (`cairn schema`).
export const ERRORS = Object.freeze({
  internal: 1,
  index_unavailable: 1,
  usage: 2,
  actor_required: 2,
  feature_disabled: 2,
  owner_only: 2,
  not_found: 3,
  nothing_to_undo: 3,
  conflict: 4,
  claimed: 4,
  validation: 5,
  no_role_column: 5,
  duplicate_id: 5,
  format_too_new: 5,
  unsafe_path: 5,
  unsupported_frontmatter: 5,
  bad_encoding: 5,
  runtime_unsupported: 5,
  locked: 6,
  confirmation_required: 7,
});

export class CairnError extends Error {
  constructor(code, message, details = {}) {
    if (!Object.hasOwn(ERRORS, code)) throw new TypeError(`unknown error code: ${code}`);
    super(message);
    this.name = 'CairnError';
    this.code = code;
    this.exit = ERRORS[code];
    this.details = details;
  }
}
