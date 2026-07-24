import { saveTaskResult, waitForTask } from '../src/task-client.mjs';

const taskIds = process.argv.slice(2);

if (taskIds.length !== 1) {
  throw new Error('Usage: npm run task -- <taskId>');
}

const task = await waitForTask(taskIds[0], {
  onStatus: ({ status }) => console.log(`Status: ${status}`),
});
const saved = await saveTaskResult(task);

console.log(`Saved task result to ${saved.directory}`);

if (task.status === 'fail') {
  console.error('Task failed:', JSON.stringify(task.error ?? task, null, 2));
  process.exitCode = 1;
}
