import type { CardDetails, CardReference } from "../types.js";
import { AirwallexApiError, AirwallexClient, type AirwallexClientOptions } from "./airwallex-client.js";
import type { CardAdapter, IssueCardRequest } from "./types.js";

/** The fields PurseString reads from Airwallex's card object (spec: "Create a Card" 202 / "Get a Card" 200). */
interface AirwallexCard {
  card_id: string;
  card_status?: string;
  created_at?: string;
}

/** Spec: "List all Sensitive Card Details" 200. All five fields are required in the response. */
interface AirwallexCardDetails {
  card_number: string;
  cvv: string;
  expiry_month: number;
  expiry_year: number;
  name_on_card?: string;
}

export interface AirwallexOptions extends AirwallexClientOptions {
  /** Every Airwallex card belongs to a cardholder; agent cards are issued to this one. It must be READY. */
  cardholderId: string;
  /** created_by on card create: per the spec, the "full legal name of user requesting new card". */
  createdBy?: string;
  /** How long to wait for a new card to leave PENDING. Tests shorten it. */
  activationWaitMs?: number;
  pollIntervalMs?: number;
}

/** Spec limits on card metadata: up to 20 keys, key names up to 20 characters, values up to 150. */
const META_VALUE_MAX = 150;

/**
 * Airwallex Issuing virtual cards (https://www.airwallex.com/docs/issuing), issued in 50+ countries and capped in
 * the purchase's own currency. One-time spends get a SINGLE-use card limited to the approved amount per
 * transaction; approved recurring spends get a MULTIPLE-use card with a monthly cap. Airwallex can't lock a card to
 * one merchant, so a recurring card is only capped, not merchant-locked.
 *
 * The create body is the virtual-card template from Airwallex's own AgentOS card-provisioning skill
 * (github.com/airwallex/airwallex-marketplace, plugins/airwallex-agentos/skills/card-provisioning) and the
 * official Node SDK's README example, checked field by field against the OpenAPI spec's IssuingNewCardRequest.
 */
export class AirwallexAdapter implements CardAdapter {
  readonly name = "airwallex";
  readonly kind = "card" as const;
  private readonly client: AirwallexClient;

  constructor(private readonly opts: AirwallexOptions) {
    this.client = new AirwallexClient(opts);
  }

  /** PAN and CVV come from a separate endpoint that needs card-details (PCI) access on the API key. */
  private async details(cardId: string, ref: Omit<CardReference, "adapter" | "token" | "last_four">): Promise<CardDetails> {
    const d = await this.client.request<AirwallexCardDetails>("GET", `/api/v1/issuing/cards/${encodeURIComponent(cardId)}/details`);
    if (!d.card_number || !d.cvv) {
      throw new Error("Airwallex did not return the card number and CVV. Your API key may not have card-details access.");
    }
    return {
      ...ref,
      adapter: this.name,
      token: cardId,
      last_four: d.card_number.slice(-4),
      pan: d.card_number,
      cvv: d.cvv,
      exp_month: String(d.expiry_month).padStart(2, "0"),
      exp_year: String(d.expiry_year),
    };
  }

  /**
   * Create answers 202 Accepted, and a card can still be PENDING; the details endpoint "will only return data for
   * active cards" (spec). Wait briefly for ACTIVE instead of failing the first details call.
   */
  private async waitActive(card: AirwallexCard): Promise<AirwallexCard> {
    const deadline = Date.now() + (this.opts.activationWaitMs ?? 15_000);
    let current = card;
    while (current.card_status === "PENDING" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, this.opts.pollIntervalMs ?? 1_000));
      current = await this.client.request<AirwallexCard>("GET", `/api/v1/issuing/cards/${encodeURIComponent(card.card_id)}`);
    }
    if (current.card_status && current.card_status !== "ACTIVE") {
      throw new Error(
        `Airwallex card ${card.card_id} is ${current.card_status}, not ACTIVE` +
          (current.card_status === "PENDING" ? "; retry in a moment and PurseString will pick up the same card." : "."),
      );
    }
    return current;
  }

  /**
   * Find the card an earlier, interrupted create made for this intent. The nickname holds the intent ID and the
   * list endpoint matches nick_name exactly (spec: "Get all Cards"), so this finds that card and no other.
   */
  private async findExisting(nickName: string): Promise<AirwallexCard | undefined> {
    const page = await this.client.request<{ items?: AirwallexCard[] }>("GET", "/api/v1/issuing/cards", {
      query: { cardholder_id: this.opts.cardholderId, nick_name: nickName, page_num: "0", page_size: "10" },
    });
    return page.items?.find((c) => c.card_status !== "CLOSED" && c.card_status !== "FAILED");
  }

  async issueCard(req: IssueCardRequest): Promise<CardDetails> {
    // The memo starts with "pursestring <intent_id>", so the nickname is unique per intent and stable across retries.
    const nickName = req.memo.slice(0, 50);
    const body = {
      // Spec: "Requests with the same request_id will be ignored. This allows requests to be replayed if client is
      // unsure of the outcome." The intent ID is unique per approved purchase.
      request_id: req.intent_id,
      cardholder_id: this.opts.cardholderId,
      created_by: this.opts.createdBy ?? "PurseString",
      form_factor: "VIRTUAL",
      // AgentOS rule: VIRTUAL -> is_personalized false.
      is_personalized: false,
      program: { purpose: "COMMERCIAL" },
      nick_name: nickName,
      metadata: {
        intent_id: req.intent_id.slice(0, META_VALUE_MAX),
        vendor_domain: req.vendor_domain.slice(0, META_VALUE_MAX),
      },
      authorization_controls: {
        allowed_transaction_count: req.single_use ? "SINGLE" : "MULTIPLE",
        transaction_limits: {
          currency: req.currency.toUpperCase(),
          // amount is a JSON number in major units (spec: IssuingSpendingLimit.amount, type number).
          limits: [{ amount: req.amount, interval: req.single_use ? "PER_TRANSACTION" : "MONTHLY" }],
        },
      },
    };

    let card: AirwallexCard | undefined;
    try {
      card = await this.client.request<AirwallexCard>("POST", "/api/v1/issuing/cards/create", { body });
    } catch (err) {
      // A replayed request_id may be refused instead of answered; the card it made is still there.
      if (!(err instanceof AirwallexApiError) || err.status >= 500 || err.status === 401 || err.status === 403) throw err;
      card = await this.findExisting(nickName).catch(() => undefined);
      if (!card) throw err;
    }
    if (!card?.card_id) card = await this.findExisting(nickName);
    if (!card?.card_id) throw new Error("Airwallex accepted the card request but returned no card_id.");

    const active = await this.waitActive(card);
    return this.details(card.card_id, {
      issued_at: active.created_at ?? card.created_at ?? new Date().toISOString(),
      spend_limit: req.amount,
      currency: req.currency.toUpperCase(),
      single_use: req.single_use,
    });
  }

  async getCard(ref: CardReference): Promise<CardDetails> {
    return this.details(ref.token, ref);
  }

  /** Spec: "Update a Card" takes card_status, whose settable values are INACTIVE, ACTIVE and CLOSED. CLOSED is final. */
  async closeCard(ref: CardReference): Promise<void> {
    await this.client.request("POST", `/api/v1/issuing/cards/${encodeURIComponent(ref.token)}/update`, {
      body: { card_status: "CLOSED" },
    });
  }
}
