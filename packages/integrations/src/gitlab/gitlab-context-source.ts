import { skeletonContextSource } from '../context-source.js';

/**
 * GitLab — commits, merge requests, deployments and (follow-up only) named files. Beside, and
 * separate from, 004's discovery adapter. Skeleton (003 T005).
 */
export const gitlabContextSource = skeletonContextSource('gitlab', [
  'gitlab_commits',
  'gitlab_merge_requests',
  'gitlab_deployments',
  'source_file',
]);
