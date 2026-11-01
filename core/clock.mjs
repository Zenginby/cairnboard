// The only place that reads the system time; everything else receives a clock.
export const systemClock = Object.freeze({ now: () => new Date() });

export function fixedClock(iso) {
  let ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new TypeError(`invalid time: ${iso}`);
  return {
    now: () => new Date(ms),
    advance(delta) {
      ms += delta;
    },
  };
}
