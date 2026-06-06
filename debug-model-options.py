#!/usr/bin/env python3
"""Debug script: call build_models_payload() directly and print the traceback."""
import os, sys, traceback, json

os.environ.setdefault("HERMES_HOME", "/opt/data")
sys.path.insert(0, "/opt/hermes")
sys.path.insert(0, "/opt/hermes/.venv/lib/python3.12/site-packages")

try:
    from hermes_cli.inventory import build_models_payload, load_picker_context
    ctx = load_picker_context()
    print("=== load_picker_context OK ===")
    print(f"  current_model: {ctx.current_model!r}")
    print(f"  current_provider: {ctx.current_provider!r}")
    print(f"  current_base_url: {ctx.current_base_url!r}")
    print(f"  user_providers: {list(ctx.user_providers.keys()) if isinstance(ctx.user_providers, dict) else type(ctx.user_providers)}")
    print(f"  custom_providers: {list(ctx.custom_providers.keys()) if isinstance(ctx.custom_providers, dict) else type(ctx.custom_providers)}")
except Exception:
    print("=== load_picker_context FAILED ===")
    traceback.print_exc()
    sys.exit(0)

try:
    result = build_models_payload(ctx, max_models=50, include_unconfigured=True, picker_hints=True, canonical_order=True, pricing=True, capabilities=True)
    print("=== build_models_payload OK ===")
    print(f"  providers count: {len(result.get('providers', []))}")
    print(f"  model: {result.get('model')!r}")
    print(f"  provider: {result.get('provider')!r}")
except Exception:
    print("=== build_models_payload FAILED ===")
    traceback.print_exc()