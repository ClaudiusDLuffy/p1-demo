let forcedDeploymentReload = false;

export function beginForcedDeploymentReload() {
  forcedDeploymentReload = true;
}

export function cancelForcedDeploymentReload() {
  forcedDeploymentReload = false;
}

export function isForcedDeploymentReload() {
  return forcedDeploymentReload;
}

