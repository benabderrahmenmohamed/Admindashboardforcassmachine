/**
 * Types of the public schema, in the shape `supabase gen types typescript` produces.
 *
 * WRITTEN BY HAND from supabase/migrations: `npm run db:types` needs the local stack, and the local
 * stack needs Docker, which this machine does not have. Once it runs, regenerate this file with that
 * script (it replaces the whole file, this note included). These types feed the Supabase adapter
 * only; the ports never import them.
 *
 * `dining_tables`, `open_orders`, `open_order_items`, `profiles.roles` and the `order_*` functions
 * are written from docs/spec.md ahead of their migration, so they are what the café model asks for
 * rather than what the database already has. Check them against the migration when it lands.
 */

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  public: {
    Tables: {
      cash_sessions: {
        Row: {
          client_z_report: Json | null;
          close_payload_hash: string | null;
          close_received_at: string | null;
          close_request_id: string | null;
          close_submitted_by: string | null;
          closed_at: string | null;
          closed_by: string | null;
          closing_counted_millimes: number | null;
          force_close_reason: string | null;
          id: string;
          open_payload_hash: string;
          open_received_at: string;
          open_submitted_by: string;
          opened_at: string;
          opened_by: string;
          opening_float_millimes: number;
          server_z_report: Json | null;
          shop_id: string;
          terminal_id: string;
        };
        Insert: {
          client_z_report?: Json | null;
          close_payload_hash?: string | null;
          close_received_at?: string | null;
          close_request_id?: string | null;
          close_submitted_by?: string | null;
          closed_at?: string | null;
          closed_by?: string | null;
          closing_counted_millimes?: number | null;
          force_close_reason?: string | null;
          id: string;
          open_payload_hash: string;
          open_received_at?: string;
          open_submitted_by: string;
          opened_at: string;
          opened_by: string;
          opening_float_millimes: number;
          server_z_report?: Json | null;
          shop_id: string;
          terminal_id: string;
        };
        Update: {
          client_z_report?: Json | null;
          close_payload_hash?: string | null;
          close_received_at?: string | null;
          close_request_id?: string | null;
          close_submitted_by?: string | null;
          closed_at?: string | null;
          closed_by?: string | null;
          closing_counted_millimes?: number | null;
          force_close_reason?: string | null;
          id?: string;
          open_payload_hash?: string;
          open_received_at?: string;
          open_submitted_by?: string;
          opened_at?: string;
          opened_by?: string;
          opening_float_millimes?: number;
          server_z_report?: Json | null;
          shop_id?: string;
          terminal_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'cash_sessions_terminal_id_shop_id_fkey';
            columns: ['terminal_id', 'shop_id'];
            isOneToOne: false;
            referencedRelation: 'terminals';
            referencedColumns: ['id', 'shop_id'];
          },
        ];
      };
      categories: {
        Row: {
          color: string;
          created_at: string;
          id: string;
          legacy_kv_key: string | null;
          name: string;
          shop_id: string;
        };
        Insert: {
          color?: string;
          created_at?: string;
          id?: string;
          legacy_kv_key?: string | null;
          name: string;
          shop_id?: string;
        };
        Update: {
          color?: string;
          created_at?: string;
          id?: string;
          legacy_kv_key?: string | null;
          name?: string;
          shop_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'categories_shop_id_fkey';
            columns: ['shop_id'];
            isOneToOne: false;
            referencedRelation: 'shops';
            referencedColumns: ['id'];
          },
        ];
      };
      dining_tables: {
        Row: {
          created_at: string;
          id: string;
          is_active: boolean;
          name: string;
          shop_id: string;
          sort_order: number;
        };
        Insert: {
          created_at?: string;
          id?: string;
          is_active?: boolean;
          name: string;
          shop_id: string;
          sort_order?: number;
        };
        Update: {
          created_at?: string;
          id?: string;
          is_active?: boolean;
          name?: string;
          shop_id?: string;
          sort_order?: number;
        };
        Relationships: [
          {
            foreignKeyName: 'dining_tables_shop_id_fkey';
            columns: ['shop_id'];
            isOneToOne: false;
            referencedRelation: 'shops';
            referencedColumns: ['id'];
          },
        ];
      };
      kv_store_81f0b18a: {
        Row: {
          key: string;
          value: Json;
        };
        Insert: {
          key: string;
          value: Json;
        };
        Update: {
          key?: string;
          value?: Json;
        };
        Relationships: [];
      };
      legacy_orders: {
        Row: {
          imported_at: string;
          kv_key: string;
          raw: Json;
          shop_id: string;
          status: string | null;
        };
        Insert: {
          imported_at?: string;
          kv_key: string;
          raw: Json;
          shop_id: string;
          status?: string | null;
        };
        Update: {
          imported_at?: string;
          kv_key?: string;
          raw?: Json;
          shop_id?: string;
          status?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'legacy_orders_shop_id_fkey';
            columns: ['shop_id'];
            isOneToOne: false;
            referencedRelation: 'shops';
            referencedColumns: ['id'];
          },
        ];
      };
      open_order_items: {
        Row: {
          added_at: string;
          added_by: string;
          id: string;
          name_snapshot: string;
          note: string;
          order_id: string;
          paid_sale_id: string | null;
          prepared_at: string | null;
          product_id: string;
          qty: number;
          removed_at: string | null;
          removed_by: string | null;
          removed_reason: string | null;
          sent_at: string | null;
          shop_id: string;
          unit_price_millimes: number;
        };
        Insert: {
          added_at: string;
          added_by: string;
          id?: string;
          name_snapshot: string;
          note?: string;
          order_id: string;
          paid_sale_id?: string | null;
          prepared_at?: string | null;
          product_id: string;
          qty: number;
          removed_at?: string | null;
          removed_by?: string | null;
          removed_reason?: string | null;
          sent_at?: string | null;
          shop_id: string;
          unit_price_millimes: number;
        };
        Update: {
          added_at?: string;
          added_by?: string;
          id?: string;
          name_snapshot?: string;
          note?: string;
          order_id?: string;
          paid_sale_id?: string | null;
          prepared_at?: string | null;
          product_id?: string;
          qty?: number;
          removed_at?: string | null;
          removed_by?: string | null;
          removed_reason?: string | null;
          sent_at?: string | null;
          shop_id?: string;
          unit_price_millimes?: number;
        };
        Relationships: [
          {
            foreignKeyName: 'open_order_items_order_id_shop_id_fkey';
            columns: ['order_id', 'shop_id'];
            isOneToOne: false;
            referencedRelation: 'open_orders';
            referencedColumns: ['id', 'shop_id'];
          },
          {
            foreignKeyName: 'open_order_items_paid_sale_id_fkey';
            columns: ['paid_sale_id'];
            isOneToOne: false;
            referencedRelation: 'sales';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'open_order_items_product_id_shop_id_fkey';
            columns: ['product_id', 'shop_id'];
            isOneToOne: false;
            referencedRelation: 'products';
            referencedColumns: ['id', 'shop_id'];
          },
        ];
      };
      open_orders: {
        Row: {
          closed_at: string | null;
          closed_reason: string | null;
          id: string;
          opened_at: string;
          shop_id: string;
          status: string;
          table_id: string;
        };
        Insert: {
          closed_at?: string | null;
          closed_reason?: string | null;
          id?: string;
          opened_at: string;
          shop_id: string;
          status?: string;
          table_id: string;
        };
        Update: {
          closed_at?: string | null;
          closed_reason?: string | null;
          id?: string;
          opened_at?: string;
          shop_id?: string;
          status?: string;
          table_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'open_orders_shop_id_fkey';
            columns: ['shop_id'];
            isOneToOne: false;
            referencedRelation: 'shops';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'open_orders_table_id_shop_id_fkey';
            columns: ['table_id', 'shop_id'];
            isOneToOne: false;
            referencedRelation: 'dining_tables';
            referencedColumns: ['id', 'shop_id'];
          },
        ];
      };
      products: {
        Row: {
          archived_at: string | null;
          is_available: boolean;
          track_stock: boolean;
          barcode: string | null;
          category_id: string | null;
          created_at: string;
          description: string;
          id: string;
          image_url: string;
          legacy_kv_key: string | null;
          name: string;
          price_millimes: number;
          shop_id: string;
          stock_qty: number;
          updated_at: string;
        };
        Insert: {
          archived_at?: string | null;
          is_available?: boolean;
          track_stock?: boolean;
          barcode?: string | null;
          category_id?: string | null;
          created_at?: string;
          description?: string;
          id?: string;
          image_url?: string;
          legacy_kv_key?: string | null;
          name: string;
          price_millimes: number;
          shop_id: string;
          stock_qty?: number;
          updated_at?: string;
        };
        Update: {
          archived_at?: string | null;
          is_available?: boolean;
          track_stock?: boolean;
          barcode?: string | null;
          category_id?: string | null;
          created_at?: string;
          description?: string;
          id?: string;
          image_url?: string;
          legacy_kv_key?: string | null;
          name?: string;
          price_millimes?: number;
          shop_id?: string;
          stock_qty?: number;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'products_category_id_shop_id_fkey';
            columns: ['category_id', 'shop_id'];
            isOneToOne: false;
            referencedRelation: 'categories';
            referencedColumns: ['id', 'shop_id'];
          },
          {
            foreignKeyName: 'products_shop_id_fkey';
            columns: ['shop_id'];
            isOneToOne: false;
            referencedRelation: 'shops';
            referencedColumns: ['id'];
          },
        ];
      };
      profiles: {
        Row: {
          created_at: string;
          display_name: string;
          /** One member often holds several: the owner is an admin who also works the counter. */
          roles: string[];
          shop_id: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          display_name?: string;
          roles: string[];
          shop_id: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          display_name?: string;
          roles?: string[];
          shop_id?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'profiles_shop_id_fkey';
            columns: ['shop_id'];
            isOneToOne: false;
            referencedRelation: 'shops';
            referencedColumns: ['id'];
          },
        ];
      };
      receipt_voids: {
        Row: {
          error_code: string;
          id: string;
          payload: Json;
          payload_hash: string;
          reason: string;
          receipt_number: string;
          seq: number;
          session_id: string | null;
          shop_id: string;
          terminal_id: string;
          voided_at: string;
          voided_by: string;
        };
        Insert: {
          error_code: string;
          id: string;
          payload: Json;
          payload_hash: string;
          reason: string;
          receipt_number: string;
          seq: number;
          session_id?: string | null;
          shop_id: string;
          terminal_id: string;
          voided_at?: string;
          voided_by: string;
        };
        Update: {
          error_code?: string;
          id?: string;
          payload?: Json;
          payload_hash?: string;
          reason?: string;
          receipt_number?: string;
          seq?: number;
          session_id?: string | null;
          shop_id?: string;
          terminal_id?: string;
          voided_at?: string;
          voided_by?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'receipt_voids_session_id_fkey';
            columns: ['session_id'];
            isOneToOne: false;
            referencedRelation: 'cash_sessions';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'receipt_voids_terminal_id_shop_id_fkey';
            columns: ['terminal_id', 'shop_id'];
            isOneToOne: false;
            referencedRelation: 'terminals';
            referencedColumns: ['id', 'shop_id'];
          },
        ];
      };
      sale_lines: {
        Row: {
          allocated_discount_millimes: number;
          line_discount_millimes: number;
          line_no: number;
          id: string;
          line_discount_reason: string | null;
          line_total_millimes: number;
          open_order_item_id: string | null;
          product_id: string;
          product_name: string;
          qty: number;
          refunds_sale_line_id: string | null;
          sale_id: string;
          shop_id: string;
          unit_price_millimes: number;
        };
        Insert: {
          allocated_discount_millimes: number;
          line_discount_millimes: number;
          line_no: number;
          id: string;
          line_discount_reason: string | null;
          line_total_millimes: number;
          open_order_item_id: string | null;
          product_id: string;
          product_name: string;
          qty: number;
          refunds_sale_line_id?: string | null;
          sale_id: string;
          shop_id: string;
          unit_price_millimes: number;
        };
        Update: {
          allocated_discount_millimes?: number;
          line_discount_millimes?: number;
          line_no?: number;
          id?: string;
          line_discount_reason?: string | null;
          line_total_millimes?: number;
          open_order_item_id?: string | null;
          product_id?: string;
          product_name?: string;
          qty?: number;
          refunds_sale_line_id?: string | null;
          sale_id?: string;
          shop_id?: string;
          unit_price_millimes?: number;
        };
        Relationships: [
          {
            foreignKeyName: 'sale_lines_product_id_shop_id_fkey';
            columns: ['product_id', 'shop_id'];
            isOneToOne: false;
            referencedRelation: 'products';
            referencedColumns: ['id', 'shop_id'];
          },
          {
            foreignKeyName: 'sale_lines_sale_id_shop_id_fkey';
            columns: ['sale_id', 'shop_id'];
            isOneToOne: false;
            referencedRelation: 'sales';
            referencedColumns: ['id', 'shop_id'];
          },
        ];
      };
      sales: {
        Row: {
          change_millimes: number;
          created_at: string;
          cart_discount_millimes: number;
          table_id: string | null;
          epoch: number;
          id: string;
          kind: string;
          payload_hash: string;
          payment_method: string;
          receipt_number: string;
          received_at: string;
          refunds_sale_id: string | null;
          seq: number;
          session_id: string;
          shop_id: string;
          submitted_by: string;
          subtotal_millimes: number;
          tendered_millimes: number;
          terminal_id: string;
          total_millimes: number;
        };
        Insert: {
          change_millimes: number;
          created_at: string;
          cart_discount_millimes: number;
          table_id: string | null;
          epoch: number;
          id: string;
          kind: string;
          payload_hash: string;
          payment_method: string;
          receipt_number: string;
          received_at?: string;
          refunds_sale_id?: string | null;
          seq: number;
          session_id: string;
          shop_id: string;
          submitted_by: string;
          subtotal_millimes: number;
          tendered_millimes: number;
          terminal_id: string;
          total_millimes: number;
        };
        Update: {
          change_millimes?: number;
          created_at?: string;
          cart_discount_millimes?: number;
          table_id?: string | null;
          epoch?: number;
          id?: string;
          kind?: string;
          payload_hash?: string;
          payment_method?: string;
          receipt_number?: string;
          received_at?: string;
          refunds_sale_id?: string | null;
          seq?: number;
          session_id?: string;
          shop_id?: string;
          submitted_by?: string;
          subtotal_millimes?: number;
          tendered_millimes?: number;
          terminal_id?: string;
          total_millimes?: number;
        };
        Relationships: [
          {
            foreignKeyName: 'sales_refunds_sale_id_fkey';
            columns: ['refunds_sale_id'];
            isOneToOne: false;
            referencedRelation: 'sales';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'sales_session_id_shop_id_fkey';
            columns: ['session_id', 'shop_id'];
            isOneToOne: false;
            referencedRelation: 'cash_sessions';
            referencedColumns: ['id', 'shop_id'];
          },
          {
            foreignKeyName: 'sales_table_id_fkey';
            columns: ['table_id', 'shop_id'];
            isOneToOne: false;
            referencedRelation: 'dining_tables';
            referencedColumns: ['id', 'shop_id'];
          },
          {
            foreignKeyName: 'sales_terminal_id_shop_id_fkey';
            columns: ['terminal_id', 'shop_id'];
            isOneToOne: false;
            referencedRelation: 'terminals';
            referencedColumns: ['id', 'shop_id'];
          },
        ];
      };
      shop_settings: {
        Row: {
          receipt_footer: string;
          shop_id: string;
          updated_at: string;
        };
        Insert: {
          receipt_footer?: string;
          shop_id: string;
          updated_at?: string;
        };
        Update: {
          receipt_footer?: string;
          shop_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'shop_settings_shop_id_fkey';
            columns: ['shop_id'];
            isOneToOne: true;
            referencedRelation: 'shops';
            referencedColumns: ['id'];
          },
        ];
      };
      shops: {
        Row: {
          created_at: string;
          id: string;
          name: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          name: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          name?: string;
        };
        Relationships: [];
      };
      stock_movements: {
        Row: {
          created_at: string;
          created_by: string | null;
          delta: number;
          id: number;
          note: string;
          product_id: string;
          reason: string;
          sale_id: string | null;
          shop_id: string;
        };
        Insert: {
          created_at?: string;
          created_by?: string | null;
          delta: number;
          id?: never;
          note?: string;
          product_id: string;
          reason: string;
          sale_id?: string | null;
          shop_id: string;
        };
        Update: {
          created_at?: string;
          created_by?: string | null;
          delta?: number;
          id?: never;
          note?: string;
          product_id?: string;
          reason?: string;
          sale_id?: string | null;
          shop_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'stock_movements_product_id_shop_id_fkey';
            columns: ['product_id', 'shop_id'];
            isOneToOne: false;
            referencedRelation: 'products';
            referencedColumns: ['id', 'shop_id'];
          },
          {
            foreignKeyName: 'stock_movements_sale_id_fkey';
            columns: ['sale_id'];
            isOneToOne: false;
            referencedRelation: 'sales';
            referencedColumns: ['id'];
          },
        ];
      };
      terminals: {
        Row: {
          code: string;
          created_at: string;
          epoch: number;
          id: string;
          last_seq: number;
          shop_id: string;
        };
        Insert: {
          code: string;
          created_at?: string;
          epoch?: number;
          id?: string;
          last_seq?: number;
          shop_id: string;
        };
        Update: {
          code?: string;
          created_at?: string;
          epoch?: number;
          id?: string;
          last_seq?: number;
          shop_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'terminals_shop_id_fkey';
            columns: ['shop_id'];
            isOneToOne: false;
            referencedRelation: 'shops';
            referencedColumns: ['id'];
          },
        ];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      archive_product: { Args: { p_product_id: string }; Returns: undefined };
      close_session: { Args: { p: Json }; Returns: Json };
      force_close_session: { Args: { p_reason: string; p_session_id: string }; Returns: Json };
      my_profile: { Args: never; Returns: Json };
      open_session: { Args: { p: Json }; Returns: Json };
      order_cancel: { Args: { p: Json }; Returns: Json };
      order_item_add: { Args: { p: Json }; Returns: Json };
      order_item_prepare: { Args: { p: Json }; Returns: Json };
      order_item_remove: { Args: { p: Json }; Returns: Json };
      order_send: { Args: { p: Json }; Returns: Json };
      adjust_stock: { Args: { p: Json }; Returns: Json };
      record_sale: { Args: { p: Json }; Returns: Json };
      register_terminal: { Args: { p_code: string }; Returns: Json };
      removed_after_sent: { Args: { p_from: string; p_to: string }; Returns: Json };
      save_dining_table: { Args: { p: Json }; Returns: Json };
      save_product: { Args: { p: Json }; Returns: Json };
      set_product_availability: {
        Args: { p_is_available: boolean; p_product_id: string };
        Returns: Json;
      };
      void_receipt: { Args: { p: Json }; Returns: Json };
      z_report: { Args: { p_session_id: string }; Returns: Json };
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type PublicSchema = Database['public'];

export type Tables<Name extends keyof PublicSchema['Tables']> = PublicSchema['Tables'][Name]['Row'];

export type TablesInsert<Name extends keyof PublicSchema['Tables']> =
  PublicSchema['Tables'][Name]['Insert'];

export type TablesUpdate<Name extends keyof PublicSchema['Tables']> =
  PublicSchema['Tables'][Name]['Update'];
