import { expect, it, vi } from 'vitest';
import { updateComment } from '../action/compare.mjs';

it('posts a first PR comment and updates its own existing marker instead of duplicating it', async () => {
  const marker = '<!-- toolcall-bench:fixture -->';
  const create = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce({ id: 1 });
  await updateComment(create, 'owner/repo', 7, marker, `${marker}\nreport`);
  expect(create).toHaveBeenLastCalledWith('/repos/owner/repo/issues/7/comments', 'POST', { body: `${marker}\nreport` });
  const update = vi.fn().mockResolvedValueOnce([{ id: 1, user: { login: 'github-actions[bot]' }, body: marker }]).mockResolvedValueOnce({ id: 1 });
  await updateComment(update, 'owner/repo', 7, marker, 'replacement');
  expect(update).toHaveBeenLastCalledWith('/repos/owner/repo/issues/comments/1', 'PATCH', { body: 'replacement' });
});
it('paginates, ignores human marker copies and propagates API errors', async () => {
  const marker = '<!-- toolcall-bench:fixture -->';
  const api = vi.fn().mockResolvedValueOnce(Array.from({ length: 100 }, () => ({ user: { login: 'human' }, body: marker })))
    .mockResolvedValueOnce([{ id: 9, user: { login: 'github-actions[bot]' }, body: marker }]).mockResolvedValueOnce({ id: 9 });
  await updateComment(api, 'owner/repo', 7, marker, 'replacement');
  expect(api).toHaveBeenNthCalledWith(2, '/repos/owner/repo/issues/7/comments?per_page=100&page=2');
  expect(api).toHaveBeenLastCalledWith('/repos/owner/repo/issues/comments/9', 'PATCH', { body: 'replacement' });
  await expect(updateComment(vi.fn().mockRejectedValue(new Error('HTTP 403')), 'owner/repo', 7, marker, '')).rejects.toThrow('HTTP 403');
});
