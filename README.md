# RealityEngine_Manager

The orchestration and visualization components of the RealityEngine Suite.

## Integrated Specification

Cross-repository deployment rules are owned by
[`RealityEngine_CI/DEPLOYMENT_CONTRACT.md`](../RealityEngine_CI/DEPLOYMENT_CONTRACT.md)
and [`RealityEngine_CI/INTEGRATED_SPECIFICATION.md`](../RealityEngine_CI/INTEGRATED_SPECIFICATION.md).
The active machine and RE/PE operations contract is described in
[`RealityEngine_Machines/docs/REALITY_PERCEPTION_OPERATIONS.md`](../RealityEngine_Machines/docs/REALITY_PERCEPTION_OPERATIONS.md).

Manager must prefer `RE_REGISTRY_URL` when it is present. Static runtime URLs
remain fallback values for local single-runtime operation.
