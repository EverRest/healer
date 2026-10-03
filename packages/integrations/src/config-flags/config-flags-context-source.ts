import { skeletonContextSource } from '../context-source.js';

/** Configuration and feature-flag source (confirmed in S0-4) — for `config_flags`. Skeleton (003 T005). */
export const configFlagsContextSource = skeletonContextSource('config-flags', ['config_flags']);
