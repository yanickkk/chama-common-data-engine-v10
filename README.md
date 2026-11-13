# Chama Common Data Engine v10.7

1. Back up your current Worker project.
2. Replace only `index.js`.
3. Keep your existing production `wrangler.jsonc` and Worker Secrets.
4. Deploy with `npx wrangler deploy`.
5. Verify `/health` reports `v10.7-naver-legacy-sisejson`.
6. Test one stock with `provider=naver-legacy` before running any batch.

See `PATCH_NOTES_v10.7.md` for exact test URLs and batch commands.

Repository: `chama-common-data-engine-v10`
