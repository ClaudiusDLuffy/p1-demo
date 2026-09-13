/** Platform-neutral service boundary types; HTTP remains owned by the facade. */
export type BillingInvoiceServiceMethod = "GET" | "POST" | "PATCH" | "DELETE";
export type BillingInvoiceServiceHandler = (request: Request) => Promise<Response>;

export type BillingInvoiceServiceDependencies = Readonly<{
  /** Marker for future repository injection; the compatibility adapter owns construction. */
  requestContext?: string;
}>;
