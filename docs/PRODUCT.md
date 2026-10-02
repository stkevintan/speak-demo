# Rehearsal — Product Definition

## What we're building

A voice AI you can rehearse a real conversation with.

You pick a situation. The AI plays the other person — a store clerk, a hiring manager, your landlord. You talk to them. And while you talk, a coach watches from the side and quietly writes down what you just said and gives feedbacks on your expression like grammar errors, inappropriate vocabulary and so on by text-based tips, without ever interrupting the scene or speaking a word out loud.

When it's over, you find out how you did.

**Who it's for:** English learners who can already hold a conversation but freeze in real situations. They know the grammar. They need the reps.

---

## The experience, end to end

**1 · Open**
One question, once: *what's your English level?* (A2 / B1 / B2). That's the entire onboarding. It remembers you from then on.

**2 · Pick a scene**
A card tells you everything in one glance:
> **Returning a faulty item**
> You: a customer with a broken item and no receipt.
> Dana: a store clerk who would rather you went away.
> **Your goal: get a refund without escalating.**
> *You're in a busy electronics store, Saturday afternoon.*

You know who you're talking to, what you want, and what's in the way. That's what makes it a game instead of a chat.

**3 · The scene starts**
Dana speaks first, in character: *"Hi there — how can I help you today?"*
You reply. From here it's completely free-form — no script, no right answer, no fixed path. Dana reacts to whatever you actually say.

**4 · Suggestion tips**
A "suggestions" switch the user can turn on or off. When it's on, the coach reads the current question and offers example responses you can tap.

They open automatically when you get stuck — four seconds of silence.


**5 · While you talk**
Cards appear on the sideline as you speak — the point in English, and a Chinese line under it so you actually understand the correction:

> ✓ **Nice** — "I've had it for about two weeks." Clean past perfect.
> ⚠ **"I go to beach"** → *"I went to the beach"* — simple past for a finished action.
> 　　「去海滩」这件事已经发生完了，用一般过去时。
> ✓ **Good pushback** — you disagreed without being rude.

You can ignore them completely, or glance when you want. They never interrupt, and Dana never mentions them. The Chinese can be switched off whenever you stop needing it.

**6 · End the scene**
You tap End. The debrief:

> **You got the refund** — but you had to escalate to a manager to do it.
>
> **What worked:** You stayed polite under pressure, and your past-tense narration was clean this time.
> **What to watch:** Articles. "I go to beach" → "I went to the beach." Three times.
> **Everything you said, fixed:** a full list of your sentences with a better version of each.
> **Next:** practise disagreeing without apologising first.

**7 · Come back tomorrow**
It remembers. The next scene opens with:
> *"Last time you dropped past tense three times — let's see if it sticks."*

That's the loop closing. That's why you come back.

---

## My Progress
Problem: A learner who has done several scenes has no sense of whether they're improving. Surface a learner's progress across sessions.

1. How many goal you have meet, how many scenes tried but unfinished, how many scenes are not started.
2. goal -> boolean => score: (time, how many coach suggestion adopted, how many good  and sharppend feedbacks)
3. For sessions with multiple attempts, goal - boolean/score

**The score.** Every attempt is scored 0–100, points achieved over points achievable. The
100 splits so that meeting the goal is worth more than everything else combined:

| What | Worth | Cap |
| --- | --- | --- |
| Goal met | 55 | all or nothing |
| Time on task | 15 | 6 minutes |
| Coach suggestions adopted | 15 | 3 |
| Coach cards (nice + upgrade) | 15 | 6 |

The 55/45 split is the whole point of the feature, not a detail. It means a winning
attempt can never score below 55 and a losing one can never score above 45, so the
number can never contradict the "Goal met" badge beside it. Split it evenly and a long,
talkative failure outranks a short success — a number that lies, which is worse than no
number at all (see **Never demoralising**).

A scene's score is its scored attempt — the win if there is one, otherwise the latest —
and the homepage recap bar shows the mean across the scenes you have actually tried.
Scenes you have not opened are excluded rather than counted as zero, and a learner with
no attempts yet sees no score at all instead of a 0.

## MVP — what we build in 2 hours

**The must-haves, in priority order:**

1. **Level question on first run, remembered** — calibrates how simple the AI's English is.
2. **6 scenes to choose from** — each with a character, a goal, and something at stake.
3. **Voice roleplay, in character** — free-form
4. **Live feedback cards while you speak** — what you said, a better version, and why — in English and Chinese.
5. **Debrief at the end** — did you win, what worked, what you repeated, every correction.
6. **It remembers your patterns** — the next session picks up where you left off.
7. **Type instead of talk** — for noisy rooms and dead microphones.

**Cut if we run short:** pronunciation notes → register category → extra scenes.

**Product priorities:** positive feedback cards, and answering "did you win?".

---

## How the tutor starts

The start is where most products lose people. Rules:

- **One question of onboarding, not a form.** Level only. Everything else is defaulted.
- **The AI speaks first.** A concrete opening line in character. The learner reacts instead of inventing — reacting is dramatically easier than starting.
- **The first line invites an easy reply.** *"How can I help you today?"* is answerable in three words. A hard opening line kills momentum before it exists.
- **No "press record", no "start speaking".** Connecting *is* starting.
- **You see what's at stake before you commit.** The scene card shows your goal up front. Knowing the goal is what turns talking into playing.
- **The character is firm, not hostile.** Dana resists you, but always leaves an opening. An unbeatable character isn't fun, it's just discouraging.

---

## How we avoid frustrating the user

This is the constraint that shapes every other decision. The learner is already nervous — they're practising precisely because this is hard for them. Every frustration is a reason to close the tab.

**Never lectured mid-scene.** The character never corrects you and never breaks character. Corrections live on the sideline where you can ignore them — and the coach is silent: it writes, it never speaks. The moment you feel graded while talking, you stop talking — and talking is the entire point.

**Never left to decode the correction.** Every explanation is written twice: once in English, once in Chinese. The English is what you say; the Chinese is why. A correction you can't parse teaches nothing.

**Never flooded.** Cap the corrections. At most one minor nit every couple of turns, never the same one twice. A wall of red text is noise, and noise gets ignored.

**Never demoralising.** Positive cards always show. Corrections are framed as upgrades — *"a sharper way to say that"* — never as errors. No pronunciation score. The only number a learner sees is the progress score, and it is built so it can never demoralise: the goal is worth 55 of the 100, so trying and failing always scores below succeeding, however long you talked. A bad number is worse than no number, so the number is weighted to stay honest — and a scene you have not tried shows no score rather than a 0.

**Never ambiguous silence.** Always show whether it's listening, thinking, or speaking. Otherwise the learner talks over the AI or waits forever wondering if it broke.

**Never a dead end.** If the mic fails, say so plainly and offer typing. Failing at setup loses the user permanently.

**Never a blank page.** The AI speaks first. The learner is always responding, never inventing from nothing.

**Never punishing to quit.** Ending early still produces a debrief. Losing the connection still produces a debrief. Even walking away mid-sentence still produces a debrief.

> **The principle behind all of it:** the learner should always know what to do next, and never feel judged for what they just did.
