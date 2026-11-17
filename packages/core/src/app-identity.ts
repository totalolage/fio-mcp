/**
 * Who the server is, in the words its users see: page titles, cookie names,
 * command hints in messages and identifier prefixes. The app supplies its own
 * values; core never names a product.
 */
export interface AppIdentity {
  /**
   * Product and command name: page titles (`<name> sign-in`), cookie names
   * (`__Host-<name>-auth`), command hints (`<name> hash-password`) and the
   * OAuth `resource_name`.
   */
  readonly name: string;
  /**
   * Short prefix of issued identifiers and secrets (`<idPrefix>_at_…`,
   * `<idPrefix>_client_…`), so a leaked one is recognisable.
   */
  readonly idPrefix: string;
}
