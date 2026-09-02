# CTRL-006 accessibility review

Automated acceptance covers the current questionnaire, demand, and profile
workspaces. It verifies landmarks, heading order, labelled controls,
keyboard-reachable actions, visible focus rules, polite/alert announcements,
textual state labels, 320 CSS-pixel reflow, 200 percent zoom, and reduced-motion
behavior in the pinned offline Chromium build.

Automated evidence is not complete WCAG certification. The following human
checks remain deliberately separate:

| Review | Status | Required completion evidence |
| --- | --- | --- |
| VoiceOver reading order and control announcements | `NOT_RUN_ENV_UNAVAILABLE` | Named reviewer, browser/assistive-technology versions, findings, and dated result |
| Text, focus, and non-text contrast | `NOT_RUN_ENV_UNAVAILABLE` | Token-by-token contrast worksheet and any approved exception |
| Keyboard focus order and comprehension | `NOT_RUN_ENV_UNAVAILABLE` | Recorded end-to-end questionnaire-to-bundle walkthrough |
| 200 percent zoom visual review | `NOT_RUN_ENV_UNAVAILABLE` | Screenshots for questionnaire, demand, and profile states at 320 CSS pixels |

No automated result advances deployment, runtime, assurance, manual
accessibility, or tenant-acceptance evidence.
