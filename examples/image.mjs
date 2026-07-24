import { saveTaskResult, submitTask, waitForTask } from '../src/task-client.mjs';

const submitted = await submitTask({
  model: 'flux-schnell/text-to-image',
  input: {
    prompt: process.env.HIAPI_IMAGE_PROMPT
      ?? 'A cinematic photograph of a red lighthouse on a rocky coast at sunrise',
    aspect_ratio: '4:3',
    num_inference_steps: 1,
  },
});

console.log(`Submitted task ${submitted.taskId}`);

const task = await waitForTask(submitted.taskId, {
  onStatus: ({ status }) => console.log(`Status: ${status}`),
});
const saved = await saveTaskResult(task);

console.log(`Saved task result to ${saved.directory}`);

if (task.status === 'fail') {
  console.error('Task failed:', JSON.stringify(task.error ?? task, null, 2));
  process.exitCode = 1;
}
