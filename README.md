# claude-dymaxion

A Claude Code plugin that pauses Claude at its next step without adding anything to the conversation. It can also pause when your quota runs low and resume when the quota resets.

Named after Buckminster Fuller's Dymaxion sleep schedule: four 30-minute naps a day.

## Install

Requires a Claude Code version that supports plugin hook modules. Tested with 2.1.299 and 2.1.303.

In Claude Code:

```
/plugin install dymaxion --marketplace nvartolomei/claude-dymaxion
```

From a shell:

```
claude plugin install dymaxion --marketplace nvartolomei/claude-dymaxion
```

In the desktop app: click + next to the prompt box and choose Plugins. Click Add marketplace, enter `nvartolomei/claude-dymaxion`, then click Add plugin.

## Use

| Command | What it does |
| --- | --- |
| `/pause` | Lets the running tool finish, then stops before the next model request or tool call. Claude stays paused until you send a prompt; notices from background agents wait until then. |
| `/pause compact` | Pauses, then compacts the conversation while the prompt cache is warm. |
| `/pause status` | Shows whether the session is paused, its quota limit, and how much of each quota window is used. |
| `/pause limit 90` | Pauses this session when the 5-hour or weekly window reaches 90%. |
| `/pause limit 90 resume` | Same, and resumes on its own when the window resets. |
| `/pause limit off` | Turns off the quota pause for this session. |

## Settings

Set these with `/plugin configure dymaxion@claude-dymaxion` to apply them to every session:

| Setting | Default | What it does |
| --- | --- | --- |
| `quotaLimit` | 0 (off) | Pauses when a quota window reaches this percent. |
| `quotaResume` | Off | Resumes when the window that caused the pause resets. |

## Notes

- Claude Code resumes only on a prompt, so the automatic resume sends one: "The quota window has reset. Continue where you left off."
- Only the main conversation pauses. Running subagents continue until they finish.
- If you resume a session yourself, Claude works past the limit until that window resets, and any scheduled resume is dropped. The settings stay on: the next time the window reaches the limit, the session pauses and resumes as before.
