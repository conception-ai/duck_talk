/**
 * Scenario definitions for UI prototyping.
 * Each scenario is a frozen snapshot of app state — no reactivity, just data.
 */

import type { Message, PendingTool, PendingApproval, Status } from '../../lib/chat-types';

export interface ScenarioState {
  messages: Message[];
  status: Status;
  pendingTool: PendingTool | null;
  pendingApproval: PendingApproval | null;
  pendingInput: string;
  toast: string;
}

export interface Scenario {
  name: string;
  description: string;
  state: ScenarioState;
}

// --- Realistic mock data ---

const CONVERSATION_MESSAGES: Message[] = [
  {
    uuid: 'u1',
    role: 'user',
    content: 'What is the latest commit on main?',
  },
  {
    uuid: 'a1',
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'The user wants to know the latest commit. I should use git log to check.' },
      { type: 'text', text: 'Let me check the git log for you.' },
      {
        type: 'tool_use',
        id: 'tool_1',
        name: 'Bash',
        input: { command: 'git log --oneline -1' },
      },
    ],
  },
  {
    uuid: 'u2',
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 'tool_1', content: '72c7f28 Added sounds' },
    ],
  },
  {
    uuid: 'a2',
    role: 'assistant',
    content: [
      {
        type: 'text',
        text: 'The latest commit on main is `72c7f28` with the message **"Added sounds"**.\n\nThis commit appears to have added sound files to the project. Would you like me to look at what files were changed in this commit?',
      },
    ],
  },
  {
    uuid: 'u3',
    role: 'user',
    content: 'Yes, show me the diff',
  },
  {
    uuid: 'a3',
    role: 'assistant',
    content: [
      { type: 'text', text: 'Here\'s the diff for that commit:' },
      {
        type: 'tool_use',
        id: 'tool_2',
        name: 'Bash',
        input: { command: 'git diff HEAD~1 --stat' },
      },
    ],
  },
  {
    uuid: 'u4',
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'tool_2',
        content: ' src/routes/live/sounds/approval.mp3 | Bin 0 -> 12543 bytes\n src/routes/live/sounds/reject.mp3   | Bin 0 -> 8921 bytes\n 2 files changed, 0 insertions(+), 0 deletions(-)',
      },
    ],
  },
  {
    uuid: 'a4',
    role: 'assistant',
    content: [
      {
        type: 'text',
        text: 'The commit added two sound files:\n\n- `approval.mp3` (12.5 KB) — likely played when an instruction is approved\n- `reject.mp3` (8.9 KB) — likely played when an instruction is rejected\n\nBoth are in the `src/routes/live/sounds/` directory, which makes sense for the voice approval flow.',
      },
    ],
  },
];

const STREAMING_TOOL: PendingTool = {
  name: 'Bash',
  args: { command: 'npm run build' },
  text: 'Running the build to check for any TypeScript errors. The output will show if there are any compilation issues...',
  blocks: [
    { type: 'text', text: 'Running the build to check for any TypeScript errors. The output will show if there are any compilation issues...' },
  ],
  streaming: true,
};

// --- Scenarios ---

export const SCENARIOS: Scenario[] = [
  {
    name: 'empty',
    description: 'No messages, idle state',
    state: {
      messages: [],
      status: 'idle',
      pendingTool: null,
      pendingApproval: null,
      pendingInput: '',
      toast: '',
    },
  },
  {
    name: 'conversation',
    description: 'Multi-turn conversation with tools',
    state: {
      messages: CONVERSATION_MESSAGES,
      status: 'idle',
      pendingTool: null,
      pendingApproval: null,
      pendingInput: '',
      toast: '',
    },
  },
  {
    name: 'streaming',
    description: 'Assistant response streaming in',
    state: {
      messages: CONVERSATION_MESSAGES.slice(0, 4),
      status: 'idle',
      pendingTool: STREAMING_TOOL,
      pendingApproval: null,
      pendingInput: '',
      toast: '',
    },
  },
  {
    name: 'approval',
    description: 'Pending user approval of instruction',
    state: {
      messages: CONVERSATION_MESSAGES.slice(0, 4),
      status: 'connected',
      pendingTool: {
        name: 'converse',
        args: { instruction: 'Refactor the authentication module to use JWT tokens instead of session cookies' },
        text: '',
        blocks: [],
        streaming: false,
      },
      pendingApproval: {
        instruction: 'Refactor the authentication module to use JWT tokens instead of session cookies',
      },
      pendingInput: '',
      toast: '',
    },
  },
  {
    name: 'error',
    description: 'Error toast visible',
    state: {
      messages: CONVERSATION_MESSAGES.slice(0, 4),
      status: 'idle',
      pendingTool: null,
      pendingApproval: null,
      pendingInput: '',
      toast: 'Gemini disconnected: Internal error occurred',
    },
  },
  {
    name: 'live',
    description: 'Live voice session active',
    state: {
      messages: CONVERSATION_MESSAGES.slice(0, 4),
      status: 'connected',
      pendingTool: null,
      pendingApproval: null,
      pendingInput: 'Can you also check if there are any TypeScript errors in the project by running the build command?',
      toast: '',
    },
  },
  {
    name: 'pending',
    description: 'Review transcribed text before sending',
    state: {
      messages: CONVERSATION_MESSAGES.slice(0, 4),
      status: 'idle',
      pendingTool: null,
      pendingApproval: null,
      pendingInput: 'Can you also check if there are any TypeScript errors in the project by running the build command?',
      toast: '',
    },
  },
];
