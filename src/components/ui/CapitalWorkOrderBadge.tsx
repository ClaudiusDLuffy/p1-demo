"use client";

import { CAPITAL_BADGE } from "../../lib/constants";
import { isCapitalWorkOrder, type WorkOrderViewRow } from "../../lib/workOrderView";
import { Badge } from "./Badge";

export const CapitalWorkOrderBadge = ({
  workOrder,
  small = false,
}: {
  workOrder?: WorkOrderViewRow | null;
  small?: boolean;
}) => isCapitalWorkOrder(workOrder)
  ? <Badge conf={CAPITAL_BADGE} small={small} />
  : null;
