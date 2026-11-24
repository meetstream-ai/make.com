import { Queue } from './queue.mjs';
const [action, id] = process.argv.slice(2);
if (!['stats', 'requeue'].includes(action)) throw new Error('Usage: node relay/manage.mjs stats | requeue DELIVERY_ID');
const queue = new Queue(process.env.RELAY_DB || '.local/relay/events.sqlite');
try {
  if (action === 'stats') console.log(JSON.stringify(queue.stats()));
  else {
    if (!/^[a-f0-9]{64}$/.test(id || '')) throw new Error('A delivery ID is required');
    console.log(JSON.stringify({ requeued: queue.requeue(id) }));
  }
} finally { queue.close(); }
