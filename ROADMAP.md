# Roadmap

What we plan to work on, in rough order. This is a direction, not a promise: plans change, and there are no dates.
Items under **Now** and **Next** link to an issue; add a 👍 there to show interest, or open a [feature request] for
something that is missing. Shipped work is listed in the [CHANGELOG](CHANGELOG.md).

Last reviewed: 0.4.1.

## Now

- **Configurable settings** ([#41]). Rename, hide and reorder board columns, set the claim lease, the agent board
  project and wiki check options from the Settings page instead of editing `config.json`.
- **Pomodoro timer** ([#33]), optional and off by default. Focus and break timer linked to a card, with an optional
  comment on the card when a focus session ends. Contributed by the community.
- **Sticky header** ([#42]). The top bar stays in place and turns translucent while scrolling.

## Next

- **Agent board** ([#43]). Show time spent and the last comment on agent cards; finished jobs move to the top and are
  archived after a chosen number of days.
- **Notifications** ([#44]). A floating notification button for finished or failed agent jobs and cards waiting on
  you, with optional browser notifications.
- **"While you were away" summary** ([#45]) on the home page, and an inbox of cards that wait on your answer.
- **Untrusted content marking** ([#46]). Text that came from outside sources (web captures, imported material) is
  marked as data, not instructions, when agents read it.
- **Break and movement reminders** ([#47]) for the timer: suggested break routines or your own reminders, with active
  hours and days.

## Later

- Assign cards to an agent, and card dependencies (`card list --ready`).
- Time, tokens and estimated cost per agent card.
- Activity heat map on the journal page.
- Read-only static export of a project or the whole folder, and a live demo from the sample data.
- Follow the board from your phone (read-only, paired with a QR code).
- Desktop app.

[feature request]: https://github.com/Zenginby/cairnboard/issues/new?template=feature_request.yml
[#33]: https://github.com/Zenginby/cairnboard/issues/33
[#41]: https://github.com/Zenginby/cairnboard/issues/41
[#42]: https://github.com/Zenginby/cairnboard/issues/42
[#43]: https://github.com/Zenginby/cairnboard/issues/43
[#44]: https://github.com/Zenginby/cairnboard/issues/44
[#45]: https://github.com/Zenginby/cairnboard/issues/45
[#46]: https://github.com/Zenginby/cairnboard/issues/46
[#47]: https://github.com/Zenginby/cairnboard/issues/47
