## INSTRUCTION

## Overview
The whole app can be divided into:
1. web: the frontend module that shows a friendly and modern UI.
2. control-plane: the backend module that manage and store state, metadata, auth and schedule.
3. agent-worker: livekit backed worker to perform LLM ASR functionality.

## Caveat
1. local dev first, DO NOT build docker while developing, but keep in mind we will eventually package project into docker container (be careful about static assets, do not hard code `process.cwd()`).
2. DO NOT create and run playwright or smoke tests.
3. DO NOT update the deisgn docs or design images except for my approval.
4. ALWAYS write design doc before implementation.

## Implementation
The project should be built as a monorepo using: nodejs + typescript (latest) + pnpm with workspace

### Courses definitions
Courses should be defined as a document type file instead of couple with logic code. 
It's location should be configured that docker compose can mount it as a volume.
Course should only provide the topic / coach hints / LLM prompts **do not fixed the trajectory**.

### Contract first
1. Must declare definitions in openapi format before implement the APIs.
2. Must declare the json schema for agent or courses definitions. do runtime check and offline check.
3. Must apply zod to validate contract before use them.

### Web
1. MUST use **tailwind** for styling
2. MUST use https://orval.dev/ to generate **React Query** based on the contract
3. Use lucide for icons if need
4. MUST use zustand to manage state besides the React Query

### API (Backend)
1. Use NestJS to create the backend server.
2. Use sqlite to store persistent state and Redis for conversation and other state.
3. MUST Create storage layer to hide sqlite and redis details.
4. Keep a scalable design (stateless?) or document how to What would you change if this needed to handle 10,000 concurrent sessions?


### Livekit Agent worker
1. Note the Speak best practice:
> Standard ASR and turn detection assume a 300–500ms pause means end-of-utterance. This breaks down for language learners, who pause constantly while searching for vocabulary, mentally conjugating verbs, or building confidence. […] Building turn detection that works for language learners is still an open problem — we're actively iterating here.
>Latency is a design problem, not just an infrastructure problem. Manual turn detection isn't just a technical fallback; it gives learners control and eliminates the anxiety of being cut off mid-thought.
> "if the feature requires understanding audio properties beyond the transcript, use speech-to-speech; otherwise cascade" — and note that pronunciation feedback is where cascade fails, because ASR normalizes a mispronounced word into the correct text.
