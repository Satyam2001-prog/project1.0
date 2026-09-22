// Ramps traffic up, holds, then ramps down — enough to trigger the HPA's
// scale-up, let you watch it settle, and then watch it scale back down
// after the cooldown period.
import http from 'k6/http';
import { sleep } from 'k6';

export const options = {
  stages: [
    { duration: '30s', target: 20 },   // ramp up to 20 virtual users
    { duration: '2m', target: 50 },    // hold heavier load — this is what triggers scale-up
    { duration: '30s', target: 0 },    // ramp down
  ],
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';

export default function () {
  http.get(`${BASE_URL}/stress?n=2000000`);
  sleep(0.3);
}
