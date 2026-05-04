// TP Scaling — k6 realistic load test script
// Simulates a real user journey hitting all services:
//   user-service (login), task-service (read + write), notification-service (read)
//
// Usage:
//   k6 run scripts/load-test-realistic.js
//   k6 run --vus 50 --duration 60s scripts/load-test-realistic.js
//   k6 run -e HIGH_VUS=100 -e EMAIL=test@example.com -e PASSWORD=password123 scripts/load-test-realistic.js
//
// Credentials can be overridden via env vars:
//   k6 run -e EMAIL=test@example.com -e PASSWORD=password123 scripts/load-test-realistic.js

import http from 'k6/http';
import { check, sleep } from 'k6';

const LOW_VUS = Number(__ENV.LOW_VUS || 10);
const HIGH_VUS = Number(__ENV.HIGH_VUS || 50);

export const options = {
  stages: [
    { duration: '30s', target: LOW_VUS },
    { duration: '1m',  target: LOW_VUS },
    { duration: '30s', target: HIGH_VUS },
    { duration: '1m',  target: HIGH_VUS },
    { duration: '30s', target: 0 },    // ramp down
  ],
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const EMAIL = __ENV.EMAIL || '';
const PASSWORD = __ENV.PASSWORD || '';

export default function () {
  const headers = { 'Content-Type': 'application/json' };

  // Step 1 — Login and retrieve a JWT token (user-service)
  const loginRes = http.post(
    `${BASE_URL}/api/users/login`,
    JSON.stringify({ email: EMAIL, password: PASSWORD }),
    { headers },
  );
  check(loginRes, { 'login 200': (r) => r.status === 200 });

  const token = loginRes.json('token');
  if (!token) return; // abort iteration if login failed

  const authHeaders = { ...headers, Authorization: `Bearer ${token}` };

  sleep(0.5);

  // Step 2 — List tasks (task-service, read)
  const tasksRes = http.get(`${BASE_URL}/api/tasks`, { headers: authHeaders });
  check(tasksRes, {
    'tasks 200': (r) => r.status === 200,
    'tasks response < 500ms': (r) => r.timings.duration < 500,
  });

  sleep(0.5);

  // Step 3 — Create a task (task-service, write)
  const createRes = http.post(
    `${BASE_URL}/api/tasks`,
    JSON.stringify({ title: `Task ${Date.now()}`, priority: 'medium' }),
    { headers: authHeaders },
  );
  check(createRes, { 'create task 201': (r) => r.status === 201 });

  sleep(0.5);

  // Step 4 — Read notifications (notification-service)
  const notifsRes = http.get(`${BASE_URL}/api/notifications`, { headers: authHeaders });
  check(notifsRes, {
    'notifs 200': (r) => r.status === 200,
    'notifs response < 500ms': (r) => r.timings.duration < 500,
  });

  sleep(1);
}
