.DEFAULT_GOAL := help

.PHONY: help prefetch bootstrap-e2e zero-bill

help prefetch bootstrap-e2e zero-bill:
	@python3 ci/run_make_target.py "$@"

%:
	@python3 ci/run_make_target.py "$@"
