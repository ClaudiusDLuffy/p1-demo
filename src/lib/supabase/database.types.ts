export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      activities: {
        Row: {
          author_id: string | null
          author_name: string
          contractor_attention_acknowledged_at: string | null
          contractor_attention_acknowledged_by: string | null
          created_at: string | null
          deleted_at: string | null
          entered_by_role: string
          event_data: Json
          event_key: string
          id: string
          is_staff_override: boolean
          is_staff_only: boolean
          override_for_contractor_id: string | null
          requires_7eleven_sync: boolean
          requires_contractor_attention: boolean
          synced_to_7eleven_at: string | null
          synced_to_7eleven_by: string | null
          text: string
          type: string | null
          work_order_id: string
          workflow_cycle: number
        }
        Insert: {
          author_id?: string | null
          author_name: string
          contractor_attention_acknowledged_at?: string | null
          contractor_attention_acknowledged_by?: string | null
          created_at?: string | null
          deleted_at?: string | null
          entered_by_role?: string
          event_data?: Json
          event_key?: string
          id?: string
          is_staff_override?: boolean
          is_staff_only?: boolean
          override_for_contractor_id?: string | null
          requires_7eleven_sync?: boolean
          requires_contractor_attention?: boolean
          synced_to_7eleven_at?: string | null
          synced_to_7eleven_by?: string | null
          text: string
          type?: string | null
          work_order_id: string
          workflow_cycle?: number
        }
        Update: {
          author_id?: string | null
          author_name?: string
          contractor_attention_acknowledged_at?: string | null
          contractor_attention_acknowledged_by?: string | null
          created_at?: string | null
          deleted_at?: string | null
          entered_by_role?: string
          event_data?: Json
          event_key?: string
          id?: string
          is_staff_override?: boolean
          is_staff_only?: boolean
          override_for_contractor_id?: string | null
          requires_7eleven_sync?: boolean
          requires_contractor_attention?: boolean
          synced_to_7eleven_at?: string | null
          synced_to_7eleven_by?: string | null
          text?: string
          type?: string | null
          work_order_id?: string
          workflow_cycle?: number
        }
        Relationships: [
          {
            foreignKeyName: "activities_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "activities_contractor_attention_acknowledged_by_fkey"
            columns: ["contractor_attention_acknowledged_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "activities_override_for_contractor_id_fkey"
            columns: ["override_for_contractor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "activities_synced_to_7eleven_by_fkey"
            columns: ["synced_to_7eleven_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "activities_work_order_id_fkey"
            columns: ["work_order_id"]
            isOneToOne: false
            referencedRelation: "work_orders"
            referencedColumns: ["id"]
          },
        ]
      }
      afms: {
        Row: {
          created_at: string | null
          email: string | null
          id: string
          name: string
          notes: string | null
          phone: string | null
          region: string | null
        }
        Insert: {
          created_at?: string | null
          email?: string | null
          id?: string
          name: string
          notes?: string | null
          phone?: string | null
          region?: string | null
        }
        Update: {
          created_at?: string | null
          email?: string | null
          id?: string
          name?: string
          notes?: string | null
          phone?: string | null
          region?: string | null
        }
        Relationships: []
      }
      billing_tax_rule_audit: {
        Row: {
          actor_id: string | null
          created_at: string
          id: number
          new_value: Json | null
          operation: string
          previous_value: Json | null
          rule_id: string
        }
        Insert: {
          actor_id?: string | null
          created_at?: string
          id?: never
          new_value?: Json | null
          operation: string
          previous_value?: Json | null
          rule_id: string
        }
        Update: {
          actor_id?: string | null
          created_at?: string
          id?: never
          new_value?: Json | null
          operation?: string
          previous_value?: Json | null
          rule_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "billing_tax_rule_audit_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      billing_tax_rules: {
        Row: {
          created_at: string
          created_by: string | null
          description_keywords: string[]
          equipment_keywords: string[]
          id: string
          is_active: boolean
          line_types: string[]
          name: string
          priority: number
          rule_key: string
          taxable: boolean
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          description_keywords?: string[]
          equipment_keywords?: string[]
          id?: string
          is_active?: boolean
          line_types?: string[]
          name: string
          priority?: number
          rule_key: string
          taxable: boolean
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          created_at?: string
          created_by?: string | null
          description_keywords?: string[]
          equipment_keywords?: string[]
          id?: string
          is_active?: boolean
          line_types?: string[]
          name?: string
          priority?: number
          rule_key?: string
          taxable?: boolean
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "billing_tax_rules_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "billing_tax_rules_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      contractor_estimate_lines: {
        Row: {
          amount: number | null
          description: string | null
          estimate_id: string
          id: string
          position: number
          qty: number
          rate: number
          type: string
        }
        Insert: {
          amount?: number | null
          description?: string | null
          estimate_id: string
          id?: string
          position: number
          qty?: number
          rate?: number
          type: string
        }
        Update: {
          amount?: number | null
          description?: string | null
          estimate_id?: string
          id?: string
          position?: number
          qty?: number
          rate?: number
          type?: string
        }
        Relationships: [
          {
            foreignKeyName: "contractor_estimate_lines_estimate_id_fkey"
            columns: ["estimate_id"]
            isOneToOne: false
            referencedRelation: "contractor_estimates"
            referencedColumns: ["id"]
          },
        ]
      }
      contractor_estimates: {
        Row: {
          contractor_assignment_version: number
          contractor_id: string
          converted_at: string | null
          converted_by: string | null
          converted_invoice_id: string | null
          created_at: string
          created_by: string
          id: string
          notes: string | null
          quote_date: string
          quote_num: string
          sales_tax: number
          state: string
          submitted_at: string | null
          submitted_by: string | null
          subtotal: number
          terms: string
          total: number | null
          updated_at: string
          updated_by: string
          valid_until: string | null
          work_order_id: string
        }
        Insert: {
          contractor_assignment_version: number
          contractor_id: string
          converted_at?: string | null
          converted_by?: string | null
          converted_invoice_id?: string | null
          created_at?: string
          created_by: string
          id?: string
          notes?: string | null
          quote_date?: string
          quote_num?: string
          sales_tax?: number
          state?: string
          submitted_at?: string | null
          submitted_by?: string | null
          subtotal?: number
          terms?: string
          total?: number | null
          updated_at?: string
          updated_by: string
          valid_until?: string | null
          work_order_id: string
        }
        Update: {
          contractor_assignment_version?: number
          contractor_id?: string
          converted_at?: string | null
          converted_by?: string | null
          converted_invoice_id?: string | null
          created_at?: string
          created_by?: string
          id?: string
          notes?: string | null
          quote_date?: string
          quote_num?: string
          sales_tax?: number
          state?: string
          submitted_at?: string | null
          submitted_by?: string | null
          subtotal?: number
          terms?: string
          total?: number | null
          updated_at?: string
          updated_by?: string
          valid_until?: string | null
          work_order_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "contractor_estimates_contractor_id_fkey"
            columns: ["contractor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contractor_estimates_converted_by_fkey"
            columns: ["converted_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contractor_estimates_converted_invoice_id_fkey"
            columns: ["converted_invoice_id"]
            isOneToOne: true
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contractor_estimates_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contractor_estimates_submitted_by_fkey"
            columns: ["submitted_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contractor_estimates_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contractor_estimates_work_order_id_fkey"
            columns: ["work_order_id"]
            isOneToOne: false
            referencedRelation: "work_orders"
            referencedColumns: ["id"]
          },
        ]
      }
      contractor_technicians: {
        Row: {
          contractor_id: string | null
          created_at: string | null
          id: string
          is_active: boolean | null
          name: string
          profile_id: string | null
          tier: string | null
          updated_at: string | null
        }
        Insert: {
          contractor_id?: string | null
          created_at?: string | null
          id?: string
          is_active?: boolean | null
          name: string
          profile_id?: string | null
          tier?: string | null
          updated_at?: string | null
        }
        Update: {
          contractor_id?: string | null
          created_at?: string | null
          id?: string
          is_active?: boolean | null
          name?: string
          profile_id?: string | null
          tier?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "contractor_technicians_contractor_id_fkey"
            columns: ["contractor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contractor_technicians_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      contractor_technician_admin_events: {
        Row: {
          access_level: string | null
          action: string
          actor_id: string
          contractor_id: string
          created_at: string
          details: Json
          id: string
          technician_profile_id: string
        }
        Insert: {
          access_level?: string | null
          action: string
          actor_id: string
          contractor_id: string
          created_at?: string
          details?: Json
          id?: string
          technician_profile_id: string
        }
        Update: {
          access_level?: string | null
          action?: string
          actor_id?: string
          contractor_id?: string
          created_at?: string
          details?: Json
          id?: string
          technician_profile_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "contractor_technician_admin_events_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contractor_technician_admin_events_contractor_id_fkey"
            columns: ["contractor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contractor_technician_admin_events_technician_profile_id_fkey"
            columns: ["technician_profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      controller_invoice_export_batches: {
        Row: {
          created_at: string
          created_by: string
          id: string
          invoice_count: number
          object_path: string
          total: number
        }
        Insert: {
          created_at?: string
          created_by: string
          id: string
          invoice_count: number
          object_path: string
          total: number
        }
        Update: {
          created_at?: string
          created_by?: string
          id?: string
          invoice_count?: number
          object_path?: string
          total?: number
        }
        Relationships: [
          {
            foreignKeyName: "controller_invoice_export_batches_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      controller_invoice_export_items: {
        Row: {
          batch_id: string
          contractor_id: string | null
          exported_at: string
          invoice_id: string
          invoice_num: string
          total: number
          work_order_id: string | null
        }
        Insert: {
          batch_id: string
          contractor_id?: string | null
          exported_at?: string
          invoice_id: string
          invoice_num: string
          total: number
          work_order_id?: string | null
        }
        Update: {
          batch_id?: string
          contractor_id?: string | null
          exported_at?: string
          invoice_id?: string
          invoice_num?: string
          total?: number
          work_order_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "controller_invoice_export_items_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "controller_invoice_export_batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "controller_invoice_export_items_contractor_id_fkey"
            columns: ["contractor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "controller_invoice_export_items_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "controller_invoice_export_items_work_order_id_fkey"
            columns: ["work_order_id"]
            isOneToOne: false
            referencedRelation: "work_orders"
            referencedColumns: ["id"]
          },
        ]
      }
      invoice_lines: {
        Row: {
          amount: number | null
          description: string | null
          id: string
          invoice_id: string
          is_taxable: boolean
          markup_percent: number | null
          position: number
          qty: number
          rate: number
          source_invoice_line_id: string | null
          source_unit_cost: number | null
          type: string
        }
        Insert: {
          amount?: number | null
          description?: string | null
          id?: string
          invoice_id: string
          is_taxable?: boolean
          markup_percent?: number | null
          position: number
          qty?: number
          rate?: number
          source_invoice_line_id?: string | null
          source_unit_cost?: number | null
          type: string
        }
        Update: {
          amount?: number | null
          description?: string | null
          id?: string
          invoice_id?: string
          is_taxable?: boolean
          markup_percent?: number | null
          position?: number
          qty?: number
          rate?: number
          source_invoice_line_id?: string | null
          source_unit_cost?: number | null
          type?: string
        }
        Relationships: [
          {
            foreignKeyName: "invoice_lines_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoice_lines_source_invoice_line_id_fkey"
            columns: ["source_invoice_line_id"]
            isOneToOne: false
            referencedRelation: "invoice_lines"
            referencedColumns: ["id"]
          },
        ]
      }
      invoices: {
        Row: {
          cme: string | null
          contractor_id: string | null
          created_at: string | null
          created_by: string | null
          deleted_at: string | null
          deleted_by: string | null
          document_kind: string
          due_date: string | null
          id: string
          invoice_date: string
          invoice_type: string
          num: string
          paid_at: string | null
          pdf_storage_path: string | null
          qbo_invoice_id: string | null
          qbo_synced_at: string | null
          rejection_reason: string | null
          rejected_at: string | null
          rejected_by: string | null
          resubmitted_at: string | null
          resubmitted_by: string | null
          review_revision: number
          sales_tax: number | null
          service_date: string | null
          source_capital_quote_id: string | null
          state: Database["public"]["Enums"]["invoice_state"]
          store_address: string | null
          store_number: string | null
          submission_key: string | null
          subtotal: number | null
          tax_jurisdiction_snapshot: Json
          tax_rate: number | null
          tax_rate_reference_id: string | null
          tax_rate_source: string | null
          tax_rate_verified_at: string | null
          tax_state: string | null
          territory: string | null
          terms: string | null
          total: number | null
          updated_at: string | null
          work_order_id: string | null
        }
        Insert: {
          cme?: string | null
          contractor_id?: string | null
          created_at?: string | null
          created_by?: string | null
          deleted_at?: string | null
          deleted_by?: string | null
          document_kind?: string
          due_date?: string | null
          id?: string
          invoice_date: string
          invoice_type?: string
          num: string
          paid_at?: string | null
          pdf_storage_path?: string | null
          qbo_invoice_id?: string | null
          qbo_synced_at?: string | null
          rejection_reason?: string | null
          rejected_at?: string | null
          rejected_by?: string | null
          resubmitted_at?: string | null
          resubmitted_by?: string | null
          review_revision?: number
          sales_tax?: number | null
          service_date?: string | null
          source_capital_quote_id?: string | null
          state?: Database["public"]["Enums"]["invoice_state"]
          store_address?: string | null
          store_number?: string | null
          submission_key?: string | null
          subtotal?: number | null
          tax_jurisdiction_snapshot?: Json
          tax_rate?: number | null
          tax_rate_reference_id?: string | null
          tax_rate_source?: string | null
          tax_rate_verified_at?: string | null
          tax_state?: string | null
          territory?: string | null
          terms?: string | null
          total?: number | null
          updated_at?: string | null
          work_order_id?: string | null
        }
        Update: {
          cme?: string | null
          contractor_id?: string | null
          created_at?: string | null
          created_by?: string | null
          deleted_at?: string | null
          deleted_by?: string | null
          document_kind?: string
          due_date?: string | null
          id?: string
          invoice_date?: string
          invoice_type?: string
          num?: string
          paid_at?: string | null
          pdf_storage_path?: string | null
          qbo_invoice_id?: string | null
          qbo_synced_at?: string | null
          rejection_reason?: string | null
          rejected_at?: string | null
          rejected_by?: string | null
          resubmitted_at?: string | null
          resubmitted_by?: string | null
          review_revision?: number
          sales_tax?: number | null
          service_date?: string | null
          source_capital_quote_id?: string | null
          state?: Database["public"]["Enums"]["invoice_state"]
          store_address?: string | null
          store_number?: string | null
          submission_key?: string | null
          subtotal?: number | null
          tax_jurisdiction_snapshot?: Json
          tax_rate?: number | null
          tax_rate_reference_id?: string | null
          tax_rate_source?: string | null
          tax_rate_verified_at?: string | null
          tax_state?: string | null
          territory?: string | null
          terms?: string | null
          total?: number | null
          updated_at?: string | null
          work_order_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "invoices_contractor_id_fkey"
            columns: ["contractor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_rejected_by_fkey"
            columns: ["rejected_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_resubmitted_by_fkey"
            columns: ["resubmitted_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_tax_rate_reference_fkey"
            columns: ["tax_rate_reference_id"]
            isOneToOne: false
            referencedRelation: "sales_tax_location_rates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_source_capital_quote_id_fkey"
            columns: ["source_capital_quote_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_work_order_id_fkey"
            columns: ["work_order_id"]
            isOneToOne: false
            referencedRelation: "work_orders"
            referencedColumns: ["id"]
          },
        ]
      }
      photos: {
        Row: {
          caption: string | null
          created_at: string | null
          id: string
          storage_path: string
          uploader_id: string | null
          uploader_name: string | null
          work_order_id: string
        }
        Insert: {
          caption?: string | null
          created_at?: string | null
          id?: string
          storage_path: string
          uploader_id?: string | null
          uploader_name?: string | null
          work_order_id: string
        }
        Update: {
          caption?: string | null
          created_at?: string | null
          id?: string
          storage_path?: string
          uploader_id?: string | null
          uploader_name?: string | null
          work_order_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "photos_uploader_id_fkey"
            columns: ["uploader_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "photos_work_order_id_fkey"
            columns: ["work_order_id"]
            isOneToOne: false
            referencedRelation: "work_orders"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          active: boolean | null
          color: string | null
          company: string | null
          contractor_access_level: "company_admin" | "invoice" | "report_only" | null
          contractor_organization_id: string | null
          contractor_tier: "direct" | "mr_freeze" | "contracted" | null
          created_at: string | null
          default_labor_rate: number | null
          default_parts_markup: number | null
          default_truck_rate: number | null
          dispatcher_id: string | null
          email: string
          id: string
          initials: string | null
          is_assignable: boolean
          name: string
          phone: string | null
          role: Database["public"]["Enums"]["user_role"]
          territory: string | null
          title: string | null
          trades: string[] | null
          updated_at: string | null
        }
        Insert: {
          active?: boolean | null
          color?: string | null
          company?: string | null
          contractor_access_level?: "company_admin" | "invoice" | "report_only" | null
          contractor_organization_id?: string | null
          contractor_tier?: "direct" | "mr_freeze" | "contracted" | null
          created_at?: string | null
          default_labor_rate?: number | null
          default_parts_markup?: number | null
          default_truck_rate?: number | null
          dispatcher_id?: string | null
          email: string
          id: string
          initials?: string | null
          is_assignable?: boolean
          name: string
          phone?: string | null
          role?: Database["public"]["Enums"]["user_role"]
          territory?: string | null
          title?: string | null
          trades?: string[] | null
          updated_at?: string | null
        }
        Update: {
          active?: boolean | null
          color?: string | null
          company?: string | null
          contractor_access_level?: "company_admin" | "invoice" | "report_only" | null
          contractor_organization_id?: string | null
          contractor_tier?: "direct" | "mr_freeze" | "contracted" | null
          created_at?: string | null
          default_labor_rate?: number | null
          default_parts_markup?: number | null
          default_truck_rate?: number | null
          dispatcher_id?: string | null
          email?: string
          id?: string
          initials?: string | null
          is_assignable?: boolean
          name?: string
          phone?: string | null
          role?: Database["public"]["Enums"]["user_role"]
          territory?: string | null
          title?: string | null
          trades?: string[] | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "profiles_dispatcher_id_fkey"
            columns: ["dispatcher_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      p1_parts_alert_deliveries: {
        Row: {
          attempt_count: number
          claimed_at: string
          completed_at: string | null
          error_message: string | null
          id: string
          local_date: string
          provider_message_id: string | null
          recipient_id: string
          request_signature: string
          status: string
        }
        Insert: {
          attempt_count?: number
          claimed_at?: string
          completed_at?: string | null
          error_message?: string | null
          id?: string
          local_date: string
          provider_message_id?: string | null
          recipient_id: string
          request_signature: string
          status?: string
        }
        Update: {
          attempt_count?: number
          claimed_at?: string
          completed_at?: string | null
          error_message?: string | null
          id?: string
          local_date?: string
          provider_message_id?: string | null
          recipient_id?: string
          request_signature?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "p1_parts_alert_deliveries_recipient_id_fkey"
            columns: ["recipient_id"]
            isOneToOne: false
            referencedRelation: "p1_parts_alert_recipients"
            referencedColumns: ["id"]
          },
        ]
      }
      p1_parts_alert_recipients: {
        Row: {
          active: boolean
          added_by: string | null
          created_at: string
          id: string
          phone_e164: string
          profile_id: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          added_by?: string | null
          created_at?: string
          id?: string
          phone_e164: string
          profile_id: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          added_by?: string | null
          created_at?: string
          id?: string
          phone_e164?: string
          profile_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "p1_parts_alert_recipients_added_by_fkey"
            columns: ["added_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "p1_parts_alert_recipients_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      p1_parts_alert_settings: {
        Row: {
          cutoff_time: string | null
          enabled: boolean
          singleton: boolean
          timezone: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          cutoff_time?: string | null
          enabled?: boolean
          singleton?: boolean
          timezone?: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          cutoff_time?: string | null
          enabled?: boolean
          singleton?: boolean
          timezone?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "p1_parts_alert_settings_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      qbo_tokens: {
        Row: {
          access_token: string
          created_at: string | null
          expires_at: string
          id: string
          realm_id: string
          refresh_token: string
          refreshed_at: string | null
        }
        Insert: {
          access_token: string
          created_at?: string | null
          expires_at: string
          id?: string
          realm_id: string
          refresh_token: string
          refreshed_at?: string | null
        }
        Update: {
          access_token?: string
          created_at?: string | null
          expires_at?: string
          id?: string
          realm_id?: string
          refresh_token?: string
          refreshed_at?: string | null
        }
        Relationships: []
      }
      service_notes: {
        Row: {
          ai_enhanced_note: string | null
          created_at: string | null
          created_by_id: string | null
          enhanced_at: string | null
          enhanced_by_id: string | null
          id: string
          raw_note: string
          work_order_id: string
        }
        Insert: {
          ai_enhanced_note?: string | null
          created_at?: string | null
          created_by_id?: string | null
          enhanced_at?: string | null
          enhanced_by_id?: string | null
          id?: string
          raw_note: string
          work_order_id: string
        }
        Update: {
          ai_enhanced_note?: string | null
          created_at?: string | null
          created_by_id?: string | null
          enhanced_at?: string | null
          enhanced_by_id?: string | null
          id?: string
          raw_note?: string
          work_order_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "service_notes_created_by_id_fkey"
            columns: ["created_by_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "service_notes_enhanced_by_id_fkey"
            columns: ["enhanced_by_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "service_notes_work_order_id_fkey"
            columns: ["work_order_id"]
            isOneToOne: false
            referencedRelation: "work_orders"
            referencedColumns: ["id"]
          },
        ]
      }
      sales_tax_location_rates: {
        Row: {
          address: string
          city: string | null
          combined_rate: number
          county: string | null
          created_at: string
          effective_from: string
          effective_to: string | null
          id: string
          import_batch_id: string
          jurisdictions: Json
          normalized_address: string
          normalized_city: string
          normalized_county: string
          postal_code: string | null
          source_reference: string | null
          state_code: string
          updated_at: string
          verification_status: string
        }
        Insert: {
          address: string
          city?: string | null
          combined_rate: number
          county?: string | null
          created_at?: string
          effective_from: string
          effective_to?: string | null
          id?: string
          import_batch_id: string
          jurisdictions?: Json
          normalized_address?: string
          normalized_city?: string
          normalized_county?: string
          postal_code?: string | null
          source_reference?: string | null
          state_code: string
          updated_at?: string
          verification_status?: string
        }
        Update: {
          address?: string
          city?: string | null
          combined_rate?: number
          county?: string | null
          created_at?: string
          effective_from?: string
          effective_to?: string | null
          id?: string
          import_batch_id?: string
          jurisdictions?: Json
          normalized_address?: string
          normalized_city?: string
          normalized_county?: string
          postal_code?: string | null
          source_reference?: string | null
          state_code?: string
          updated_at?: string
          verification_status?: string
        }
        Relationships: [
          {
            foreignKeyName: "sales_tax_location_rates_import_batch_id_fkey"
            columns: ["import_batch_id"]
            isOneToOne: false
            referencedRelation: "tax_rate_import_batches"
            referencedColumns: ["id"]
          },
        ]
      }
      state_sales_tax_rates: {
        Row: {
          created_at: string
          created_by: string | null
          effective_from: string
          effective_to: string | null
          id: string
          rate: number
          state_code: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          effective_from: string
          effective_to?: string | null
          id?: string
          rate: number
          state_code: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          effective_from?: string
          effective_to?: string | null
          id?: string
          rate?: number
          state_code?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "state_sales_tax_rates_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      staff_invoice_default_series: {
        Row: {
          next_number: number
          number_width: number
          prefix: string
          singleton: boolean
          updated_at: string
        }
        Insert: {
          next_number: number
          number_width?: number
          prefix: string
          singleton?: boolean
          updated_at?: string
        }
        Update: {
          next_number?: number
          number_width?: number
          prefix?: string
          singleton?: boolean
          updated_at?: string
        }
        Relationships: []
      }
      tax_rate_import_batches: {
        Row: {
          effective_from: string
          id: string
          imported_at: string
          imported_by: string | null
          notes: string | null
          source_file_sha256: string | null
          source_name: string
          source_url: string
          source_version: string
          state_code: string
        }
        Insert: {
          effective_from: string
          id?: string
          imported_at?: string
          imported_by?: string | null
          notes?: string | null
          source_file_sha256?: string | null
          source_name: string
          source_url: string
          source_version: string
          state_code: string
        }
        Update: {
          effective_from?: string
          id?: string
          imported_at?: string
          imported_by?: string | null
          notes?: string | null
          source_file_sha256?: string | null
          source_name?: string
          source_url?: string
          source_version?: string
          state_code?: string
        }
        Relationships: [
          {
            foreignKeyName: "tax_rate_import_batches_imported_by_fkey"
            columns: ["imported_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      staff_permission_grants: {
        Row: {
          created_at: string
          granted_by: string | null
          permission: string
          profile_id: string
        }
        Insert: {
          created_at?: string
          granted_by?: string | null
          permission: string
          profile_id: string
        }
        Update: {
          created_at?: string
          granted_by?: string | null
          permission?: string
          profile_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "staff_permission_grants_granted_by_fkey"
            columns: ["granted_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_permission_grants_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      staff_work_order_notification_reads: {
        Row: {
          read_through_at: string
          updated_at: string
          user_id: string
          work_order_id: string
        }
        Insert: {
          read_through_at: string
          updated_at?: string
          user_id: string
          work_order_id: string
        }
        Update: {
          read_through_at?: string
          updated_at?: string
          user_id?: string
          work_order_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "staff_work_order_notification_reads_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_work_order_notification_reads_work_order_id_fkey"
            columns: ["work_order_id"]
            isOneToOne: false
            referencedRelation: "work_orders"
            referencedColumns: ["id"]
          },
        ]
      }
      staff_work_order_todos: {
        Row: {
          completed_at: string | null
          completed_by: string | null
          completed_reason: string | null
          created_at: string
          created_by: string
          id: string
          note: string | null
          owner_id: string
          updated_at: string
          work_order_id: string
        }
        Insert: {
          completed_at?: string | null
          completed_by?: string | null
          completed_reason?: string | null
          created_at?: string
          created_by: string
          id?: string
          note?: string | null
          owner_id: string
          updated_at?: string
          work_order_id: string
        }
        Update: {
          completed_at?: string | null
          completed_by?: string | null
          completed_reason?: string | null
          created_at?: string
          created_by?: string
          id?: string
          note?: string | null
          owner_id?: string
          updated_at?: string
          work_order_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "staff_work_order_todos_completed_by_fkey"
            columns: ["completed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_work_order_todos_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_work_order_todos_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_work_order_todos_work_order_id_fkey"
            columns: ["work_order_id"]
            isOneToOne: false
            referencedRelation: "work_orders"
            referencedColumns: ["id"]
          },
        ]
      }
      staff_invoice_number_series: {
        Row: {
          next_number: number
          prefix: string
          updated_at: string
          user_id: string
        }
        Insert: {
          next_number: number
          prefix: string
          updated_at?: string
          user_id: string
        }
        Update: {
          next_number?: number
          prefix?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "staff_invoice_number_series_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      staff_invoice_sources: {
        Row: {
          contractor_invoice_id: string
          created_at: string
          created_by: string | null
          id: string
          staff_invoice_id: string
          work_order_id: string
        }
        Insert: {
          contractor_invoice_id: string
          created_at?: string
          created_by?: string | null
          id?: string
          staff_invoice_id: string
          work_order_id: string
        }
        Update: {
          contractor_invoice_id?: string
          created_at?: string
          created_by?: string | null
          id?: string
          staff_invoice_id?: string
          work_order_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "staff_invoice_sources_contractor_invoice_id_fkey"
            columns: ["contractor_invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_invoice_sources_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_invoice_sources_staff_invoice_id_fkey"
            columns: ["staff_invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_invoice_sources_work_order_id_fkey"
            columns: ["work_order_id"]
            isOneToOne: false
            referencedRelation: "work_orders"
            referencedColumns: ["id"]
          },
        ]
      }
      stores: {
        Row: {
          address: string | null
          city: string | null
          created_at: string | null
          default_afm_id: string | null
          notes: string | null
          state: string | null
          store_number: string
        }
        Insert: {
          address?: string | null
          city?: string | null
          created_at?: string | null
          default_afm_id?: string | null
          notes?: string | null
          state?: string | null
          store_number: string
        }
        Update: {
          address?: string | null
          city?: string | null
          created_at?: string | null
          default_afm_id?: string | null
          notes?: string | null
          state?: string | null
          store_number?: string
        }
        Relationships: [
          {
            foreignKeyName: "stores_default_afm_id_fkey"
            columns: ["default_afm_id"]
            isOneToOne: false
            referencedRelation: "afms"
            referencedColumns: ["id"]
          },
        ]
      }
      wo_parts: {
        Row: {
          created_at: string | null
          created_by: string | null
          description: string
          expected_return_date: string | null
          id: string
          notes: string | null
          ordering_responsibility: string
          p1_order_status: string | null
          p1_requested_at: string | null
          p1_requested_by: string | null
          p1_resolved_at: string | null
          p1_resolved_by: string | null
          part_number: string | null
          qty: number | null
          status: string
          tracking_number: string | null
          updated_at: string | null
          work_order_id: string
        }
        Insert: {
          created_at?: string | null
          created_by?: string | null
          description: string
          expected_return_date?: string | null
          id?: string
          notes?: string | null
          ordering_responsibility?: string
          p1_order_status?: string | null
          p1_requested_at?: string | null
          p1_requested_by?: string | null
          p1_resolved_at?: string | null
          p1_resolved_by?: string | null
          part_number?: string | null
          qty?: number | null
          status?: string
          tracking_number?: string | null
          updated_at?: string | null
          work_order_id: string
        }
        Update: {
          created_at?: string | null
          created_by?: string | null
          description?: string
          expected_return_date?: string | null
          id?: string
          notes?: string | null
          ordering_responsibility?: string
          p1_order_status?: string | null
          p1_requested_at?: string | null
          p1_requested_by?: string | null
          p1_resolved_at?: string | null
          p1_resolved_by?: string | null
          part_number?: string | null
          qty?: number | null
          status?: string
          tracking_number?: string | null
          updated_at?: string | null
          work_order_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "wo_parts_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "wo_parts_p1_requested_by_fkey"
            columns: ["p1_requested_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "wo_parts_p1_resolved_by_fkey"
            columns: ["p1_resolved_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "wo_parts_work_order_id_fkey"
            columns: ["work_order_id"]
            isOneToOne: false
            referencedRelation: "work_orders"
            referencedColumns: ["id"]
          },
        ]
      }
      work_reports: {
        Row: {
          arrival_time: string | null
          contractor_id: string | null
          created_at: string | null
          departure_time: string | null
          id: string
          parts_used: Json | null
          resolution_code: string | null
          resolution_notes: string | null
          submitted_at: string | null
          technician_name: string | null
          work_order_id: string
          work_performed: string | null
        }
        Insert: {
          arrival_time?: string | null
          contractor_id?: string | null
          created_at?: string | null
          departure_time?: string | null
          id?: string
          parts_used?: Json | null
          resolution_code?: string | null
          resolution_notes?: string | null
          submitted_at?: string | null
          technician_name?: string | null
          work_order_id: string
          work_performed?: string | null
        }
        Update: {
          arrival_time?: string | null
          contractor_id?: string | null
          created_at?: string | null
          departure_time?: string | null
          id?: string
          parts_used?: Json | null
          resolution_code?: string | null
          resolution_notes?: string | null
          submitted_at?: string | null
          technician_name?: string | null
          work_order_id?: string
          work_performed?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "work_reports_contractor_id_fkey"
            columns: ["contractor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "work_reports_work_order_id_fkey"
            columns: ["work_order_id"]
            isOneToOne: false
            referencedRelation: "work_orders"
            referencedColumns: ["id"]
          },
        ]
      }
      work_order_afm_contacts: {
        Row: {
          afm_email: string | null
          created_at: string
          updated_at: string
          work_order_id: string
        }
        Insert: {
          afm_email?: string | null
          created_at?: string
          updated_at?: string
          work_order_id: string
        }
        Update: {
          afm_email?: string | null
          created_at?: string
          updated_at?: string
          work_order_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "work_order_afm_contacts_work_order_id_fkey"
            columns: ["work_order_id"]
            isOneToOne: true
            referencedRelation: "work_orders"
            referencedColumns: ["id"]
          },
        ]
      }
      work_order_assignment_history: {
        Row: {
          assignment_ended_at: string
          assignment_ended_by: string | null
          assignment_started_at: string | null
          assignment_version: number
          contractor_id: string
          created_at: string
          id: string
          next_contractor_id: string | null
          work_order_id: string
          workflow_snapshot: Json
        }
        Insert: {
          assignment_ended_at?: string
          assignment_ended_by?: string | null
          assignment_started_at?: string | null
          assignment_version: number
          contractor_id: string
          created_at?: string
          id?: string
          next_contractor_id?: string | null
          work_order_id: string
          workflow_snapshot?: Json
        }
        Update: {
          assignment_ended_at?: string
          assignment_ended_by?: string | null
          assignment_started_at?: string | null
          assignment_version?: number
          contractor_id?: string
          created_at?: string
          id?: string
          next_contractor_id?: string | null
          work_order_id?: string
          workflow_snapshot?: Json
        }
        Relationships: [
          {
            foreignKeyName: "work_order_assignment_history_assignment_ended_by_fkey"
            columns: ["assignment_ended_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "work_order_assignment_history_contractor_id_fkey"
            columns: ["contractor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "work_order_assignment_history_next_contractor_id_fkey"
            columns: ["next_contractor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "work_order_assignment_history_work_order_id_fkey"
            columns: ["work_order_id"]
            isOneToOne: false
            referencedRelation: "work_orders"
            referencedColumns: ["id"]
          },
        ]
      }
      work_order_technician_assignments: {
        Row: {
          assigned_at: string
          assigned_by: string | null
          ended_at: string | null
          ended_by: string | null
          id: string
          technician_profile_id: string
          work_order_id: string
        }
        Insert: {
          assigned_at?: string
          assigned_by?: string | null
          ended_at?: string | null
          ended_by?: string | null
          id?: string
          technician_profile_id: string
          work_order_id: string
        }
        Update: {
          assigned_at?: string
          assigned_by?: string | null
          ended_at?: string | null
          ended_by?: string | null
          id?: string
          technician_profile_id?: string
          work_order_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "work_order_technician_assignments_assigned_by_fkey"
            columns: ["assigned_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "work_order_technician_assignments_ended_by_fkey"
            columns: ["ended_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "work_order_technician_assignments_technician_profile_id_fkey"
            columns: ["technician_profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "work_order_technician_assignments_work_order_id_fkey"
            columns: ["work_order_id"]
            isOneToOne: false
            referencedRelation: "work_orders"
            referencedColumns: ["id"]
          },
        ]
      }
      work_order_visits: {
        Row: {
          check_in_activity_id: string | null
          check_in_at: string
          check_out_activity_id: string | null
          check_out_at: string | null
          checked_in_by: string
          checked_out_by: string | null
          contractor_id: string
          created_at: string
          id: string
          updated_at: string
          work_order_id: string
        }
        Insert: {
          check_in_activity_id?: string | null
          check_in_at?: string
          check_out_activity_id?: string | null
          check_out_at?: string | null
          checked_in_by: string
          checked_out_by?: string | null
          contractor_id: string
          created_at?: string
          id?: string
          updated_at?: string
          work_order_id: string
        }
        Update: {
          check_in_activity_id?: string | null
          check_in_at?: string
          check_out_activity_id?: string | null
          check_out_at?: string | null
          checked_in_by?: string
          checked_out_by?: string | null
          contractor_id?: string
          created_at?: string
          id?: string
          updated_at?: string
          work_order_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "work_order_visits_check_in_activity_id_fkey"
            columns: ["check_in_activity_id"]
            isOneToOne: false
            referencedRelation: "activities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "work_order_visits_check_out_activity_id_fkey"
            columns: ["check_out_activity_id"]
            isOneToOne: false
            referencedRelation: "activities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "work_order_visits_checked_in_by_fkey"
            columns: ["checked_in_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "work_order_visits_checked_out_by_fkey"
            columns: ["checked_out_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "work_order_visits_contractor_id_fkey"
            columns: ["contractor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "work_order_visits_work_order_id_fkey"
            columns: ["work_order_id"]
            isOneToOne: false
            referencedRelation: "work_orders"
            referencedColumns: ["id"]
          },
        ]
      }
      work_orders: {
        Row: {
          address: string | null
          assigned_technician_profile_id: string | null
          afm_email: string | null
          afm_id: string | null
          afm_name: string | null
          asset_make: string | null
          asset_model: string | null
          asset_serial: string | null
          asset_year: number | null
          business_service: string | null
          billing_only: boolean
          billing_ready_at: string | null
          billing_ready_by: string | null
          capital_status: Database["public"]["Enums"]["capital_status"] | null
          capital_notes: string | null
          category: string | null
          city: string | null
          closed_at: string | null
          contractor_assignment_started_at: string | null
          contractor_assignment_version: number
          contractor_invoicing_assignment_version: number | null
          contractor_invoicing_completed_at: string | null
          contractor_invoicing_completed_by: string | null
          contractor_invoicing_completion_source: string | null
          contractor_invoicing_workflow_cycle: number | null
          contractor_id: string | null
          created_at: string | null
          created_by: string | null
          deleted_at: string | null
          deleted_by: string | null
          description: string | null
          dispatched_at: string | null
          end_time: string | null
          eta: string | null
          functional_status:
            | Database["public"]["Enums"]["fsm_functional_status"]
            | null
          id: string
          incident_id: string | null
          install_quote: number | null
          invoice_total: number | null
          is_capital: boolean | null
          line_of_service: string | null
          nte: number | null
          nte_flag_amount: number | null
          nte_flag_threshold: number | null
          nte_flagged: boolean | null
          part_eta: string | null
          part_needed: string | null
          priority: Database["public"]["Enums"]["wo_priority"]
          repair_quote: number | null
          resolution_breach_at: string | null
          resolution_code: string | null
          resolution_notes: string | null
          response_breach_at: string | null
          sla_breached_at: string | null
          sla_deadline_at: string | null
          sla_duration_hours: number | null
          sla_started_at: string | null
          source: string | null
          staff_notes_seen_at: string | null
          start_time: string | null
          status: Database["public"]["Enums"]["wo_status"]
          store_number: string | null
          store_county: string | null
          store_postal_code: string | null
          store_state: string | null
          store_timezone: string | null
          sub_category: string | null
          summary: string | null
          technician_on_job: string | null
          technician_assigned_at: string | null
          technician_assigned_by: string | null
          updated_at: string | null
          workflow_cycle: number
        }
        Insert: {
          address?: string | null
          assigned_technician_profile_id?: string | null
          afm_email?: string | null
          afm_id?: string | null
          afm_name?: string | null
          asset_make?: string | null
          asset_model?: string | null
          asset_serial?: string | null
          asset_year?: number | null
          business_service?: string | null
          billing_only?: boolean
          billing_ready_at?: string | null
          billing_ready_by?: string | null
          capital_status?: Database["public"]["Enums"]["capital_status"] | null
          capital_notes?: string | null
          category?: string | null
          city?: string | null
          closed_at?: string | null
          contractor_assignment_started_at?: string | null
          contractor_assignment_version?: number
          contractor_invoicing_assignment_version?: number | null
          contractor_invoicing_completed_at?: string | null
          contractor_invoicing_completed_by?: string | null
          contractor_invoicing_completion_source?: string | null
          contractor_invoicing_workflow_cycle?: number | null
          contractor_id?: string | null
          created_at?: string | null
          created_by?: string | null
          deleted_at?: string | null
          deleted_by?: string | null
          description?: string | null
          dispatched_at?: string | null
          end_time?: string | null
          eta?: string | null
          functional_status?:
            | Database["public"]["Enums"]["fsm_functional_status"]
            | null
          id: string
          incident_id?: string | null
          install_quote?: number | null
          invoice_total?: number | null
          is_capital?: boolean | null
          line_of_service?: string | null
          nte?: number | null
          nte_flag_amount?: number | null
          nte_flag_threshold?: number | null
          nte_flagged?: boolean | null
          part_eta?: string | null
          part_needed?: string | null
          priority?: Database["public"]["Enums"]["wo_priority"]
          repair_quote?: number | null
          resolution_breach_at?: string | null
          resolution_code?: string | null
          resolution_notes?: string | null
          response_breach_at?: string | null
          sla_breached_at?: string | null
          sla_deadline_at?: string | null
          sla_duration_hours?: number | null
          sla_started_at?: string | null
          source?: string | null
          staff_notes_seen_at?: string | null
          start_time?: string | null
          status?: Database["public"]["Enums"]["wo_status"]
          store_number?: string | null
          store_county?: string | null
          store_postal_code?: string | null
          store_state?: string | null
          store_timezone?: string | null
          sub_category?: string | null
          summary?: string | null
          technician_on_job?: string | null
          technician_assigned_at?: string | null
          technician_assigned_by?: string | null
          updated_at?: string | null
          workflow_cycle?: number
        }
        Update: {
          address?: string | null
          assigned_technician_profile_id?: string | null
          afm_email?: string | null
          afm_id?: string | null
          afm_name?: string | null
          asset_make?: string | null
          asset_model?: string | null
          asset_serial?: string | null
          asset_year?: number | null
          business_service?: string | null
          billing_only?: boolean
          billing_ready_at?: string | null
          billing_ready_by?: string | null
          capital_status?: Database["public"]["Enums"]["capital_status"] | null
          capital_notes?: string | null
          category?: string | null
          city?: string | null
          closed_at?: string | null
          contractor_assignment_started_at?: string | null
          contractor_assignment_version?: number
          contractor_invoicing_assignment_version?: number | null
          contractor_invoicing_completed_at?: string | null
          contractor_invoicing_completed_by?: string | null
          contractor_invoicing_completion_source?: string | null
          contractor_invoicing_workflow_cycle?: number | null
          contractor_id?: string | null
          created_at?: string | null
          created_by?: string | null
          deleted_at?: string | null
          deleted_by?: string | null
          description?: string | null
          dispatched_at?: string | null
          end_time?: string | null
          eta?: string | null
          functional_status?:
            | Database["public"]["Enums"]["fsm_functional_status"]
            | null
          id?: string
          incident_id?: string | null
          install_quote?: number | null
          invoice_total?: number | null
          is_capital?: boolean | null
          line_of_service?: string | null
          nte?: number | null
          nte_flag_amount?: number | null
          nte_flag_threshold?: number | null
          nte_flagged?: boolean | null
          part_eta?: string | null
          part_needed?: string | null
          priority?: Database["public"]["Enums"]["wo_priority"]
          repair_quote?: number | null
          resolution_breach_at?: string | null
          resolution_code?: string | null
          resolution_notes?: string | null
          response_breach_at?: string | null
          sla_breached_at?: string | null
          sla_deadline_at?: string | null
          sla_duration_hours?: number | null
          sla_started_at?: string | null
          source?: string | null
          staff_notes_seen_at?: string | null
          start_time?: string | null
          status?: Database["public"]["Enums"]["wo_status"]
          store_number?: string | null
          store_county?: string | null
          store_postal_code?: string | null
          store_state?: string | null
          store_timezone?: string | null
          sub_category?: string | null
          summary?: string | null
          technician_on_job?: string | null
          technician_assigned_at?: string | null
          technician_assigned_by?: string | null
          updated_at?: string | null
          workflow_cycle?: number
        }
        Relationships: [
          {
            foreignKeyName: "work_orders_assigned_technician_profile_id_fkey"
            columns: ["assigned_technician_profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "work_orders_billing_ready_by_fkey"
            columns: ["billing_ready_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "work_orders_technician_assigned_by_fkey"
            columns: ["technician_assigned_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "work_orders_afm_id_fkey"
            columns: ["afm_id"]
            isOneToOne: false
            referencedRelation: "afms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "work_orders_contractor_id_fkey"
            columns: ["contractor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "work_orders_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "work_orders_deleted_by_fkey"
            columns: ["deleted_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      add_work_order_to_my_todos: {
        Args: { p_note?: string | null; p_work_order_id: string }
        Returns: Database["public"]["Tables"]["staff_work_order_todos"]["Row"]
      }
      acknowledge_contractor_attention: {
        Args: { p_activity_id: string }
        Returns: undefined
      }
      assign_contractor_technician: {
        Args: {
          p_technician_profile_id: string | null
          p_work_order_id: string
        }
        Returns: Database["public"]["Tables"]["work_orders"]["Row"]
      }
      attach_contractor_invoice_pdf: {
        Args: { p_invoice_id: string; p_storage_path: string }
        Returns: undefined
      }
      claim_p1_parts_alert_delivery: {
        Args: {
          p_local_date: string
          p_recipient_id: string
          p_request_signature: string
        }
        Returns: string | null
      }
      complete_controller_invoice_export: {
        Args: {
          p_actor_id: string
          p_batch_id: string
          p_invoice_ids: string[]
          p_object_path: string
        }
        Returns: Json
      }
      complete_p1_parts_alert_delivery: {
        Args: {
          p_delivery_id: string
          p_error_message?: string | null
          p_provider_message_id?: string | null
          p_status: string
        }
        Returns: undefined
      }
      complete_work_order_once: {
        Args: {
          p_activity_text: string
          p_asset_make: string
          p_asset_model: string
          p_asset_serial: string
          p_asset_year: number | null
          p_completed_at: string
          p_resolution_code: string | null
          p_resolution_notes: string | null
          p_work_order_id: string
        }
        Returns: Json
      }
      complete_my_work_order_todo: {
        Args: { p_work_order_id: string }
        Returns: Database["public"]["Tables"]["staff_work_order_todos"]["Row"]
      }
      configure_contractor_technician: {
        Args: {
          p_access_level: string
          p_actor_id: string
          p_contractor_id: string
          p_name: string
          p_phone: string | null
          p_profile_id: string
        }
        Returns: Json
      }
      configure_p1_parts_alerts: {
        Args: {
          p_actor_id: string
          p_cutoff_time: string | null
          p_enabled: boolean
          p_recipients: Json
          p_timezone: string
        }
        Returns: Json
      }
      contractor_account_id_for_profile: {
        Args: { p_profile_id: string }
        Returns: string | null
      }
      contractor_invoice_work_order_status: {
        Args: { p_work_order_id: string }
        Returns: Database["public"]["Enums"]["wo_status"] | null
      }
      contractor_invoicing_is_complete: {
        Args: { p_work_order_id: string }
        Returns: boolean
      }
      correct_contractor_invoice_total: {
        Args: {
          p_invoice_id: string
          p_reason?: string | null
          p_total: number
        }
        Returns: Database["public"]["Tables"]["invoices"]["Row"]
      }
      convert_contractor_estimate_to_invoice: {
        Args: { p_estimate_id: string }
        Returns: Json
      }
      delete_own_contractor_invoice: {
        Args: { p_invoice_id: string }
        Returns: Json
      }
      finish_contractor_invoicing: {
        Args: { p_work_order_id: string }
        Returns: Json
      }
      submit_contractor_invoice_once: {
        Args: {
          p_cme: string | null
          p_due_date: string | null
          p_invoice_date: string | null
          p_lines: Json
          p_num: string
          p_sales_tax: number | null
          p_service_date: string | null
          p_store_address: string | null
          p_submission_key: string
          p_terms: string | null
          p_total_override: number | null
          p_user_typed_num: boolean
          p_work_order_id: string
        }
        Returns: Database["public"]["Tables"]["invoices"]["Row"]
      }
      get_incident_reuse_warnings: {
        Args: never
        Returns: {
          crosses_state: boolean
          incident_id: string
          related_work_order_ids: string[]
          work_order_id: string
        }[]
      }
      get_work_order_activity_summaries: {
        Args: never
        Returns: {
          latest_contractor_activity_at: string | null
          latest_note_at: string | null
          pending_7eleven_sync_count: number
          pending_contractor_attention_count: number
          work_order_id: string
        }[]
      }
      can_access_contractor_work_order: {
        Args: { p_work_order_id: string }
        Returns: boolean
      }
      can_manage_work_order_technician: {
        Args: { p_work_order_id: string }
        Returns: boolean
      }
      close_work_order_without_invoice: {
        Args: { p_work_order_id: string }
        Returns: Json
      }
      complete_capital_work: {
        Args: { p_work_order_id: string }
        Returns: Database["public"]["Tables"]["work_orders"]["Row"]
      }
      mark_staff_work_order_read: {
        Args: { p_read_through_at: string; p_work_order_id: string }
        Returns: Database["public"]["Tables"]["staff_work_order_notification_reads"]["Row"]
      }
      list_work_orders_table_page: {
        Args: {
          p_contractor_filter?: string | null
          p_contractor_id?: string | null
          p_contractor_ids?: string[] | null
          p_created_date_filter?: string | null
          p_cursor?: string | null
          p_from?: string | null
          p_incident_filter?: string | null
          p_limit?: number
          p_needs_action?: boolean
          p_pending_first?: boolean
          p_priority?: string | null
          p_resolution?: string | null
          p_scope?: string
          p_search?: string | null
          p_sla_filter?: string | null
          p_sort?: string
          p_sort_column?: string
          p_sort_direction?: string
          p_state?: string | null
          p_status?: string | null
          p_store_filter?: string | null
          p_store_number?: string | null
          p_summary_filter?: string | null
          p_to?: string | null
          p_updated_date_filter?: string | null
          p_work_order_filter?: string | null
        }
        Returns: Json
      }
      list_staff_contractor_preview_invoices: {
        Args: {
          p_contractor_id: string
          p_cursor_created_at?: string | null
          p_cursor_id?: string | null
          p_limit?: number
          p_search?: string | null
          p_state?: string
        }
        Returns: Json
      }
      list_staff_contractor_preview_work_orders: {
        Args: {
          p_contractor_id: string
          p_cursor_created_at?: string | null
          p_cursor_id?: string | null
          p_limit?: number
          p_scope?: string
          p_search?: string | null
        }
        Returns: Json
      }
      mark_staff_invoice_billed: {
        Args: {
          p_actor_id: string
          p_invoice_id: string
        }
        Returns: Json
      }
      deactivate_contractor_technician: {
        Args: { p_actor_id: string; p_profile_id: string }
        Returns: Json
      }
      resume_capital_work: {
        Args: { p_work_order_id: string }
        Returns: Database["public"]["Tables"]["work_orders"]["Row"]
      }
      save_staff_billing_invoice: {
        Args: {
          p_actor_id: string
          p_cme: string | null
          p_due_date: string | null
          p_invoice_date: string
          p_invoice_id: string | null
          p_lines: Json
          p_num: string
          p_sales_tax: number
          p_service_date: string | null
          p_source_invoice_ids: string[]
          p_state: string
          p_store_address: string | null
          p_store_number: string
          p_tax_rate: number | null
          p_tax_state: string | null
          p_terms: string
          p_territory: string
          p_work_order_id: string | null
        }
        Returns: string
      }
      save_contractor_estimate: {
        Args: {
          p_estimate_id: string | null
          p_expected_updated_at?: string | null
          p_lines: Json
          p_notes: string | null
          p_quote_date: string
          p_sales_tax: number
          p_submit?: boolean
          p_terms: string
          p_valid_until: string | null
          p_work_order_id: string
        }
        Returns: Json
      }
      move_work_order_straight_to_billing: {
        Args: { p_work_order_id: string }
        Returns: Database["public"]["Tables"]["work_orders"]["Row"]
      }
      is_invoice_controller: { Args: never; Returns: boolean }
      is_staff: { Args: never; Returns: boolean }
      has_staff_permission: {
        Args: { p_permission: string }
        Returns: boolean
      }
      next_contractor_invoice_num: { Args: never; Returns: string }
      next_staff_invoice_num: {
        Args: { p_actor_id: string }
        Returns: string
      }
      peek_staff_invoice_num: {
        Args: { p_actor_id: string }
        Returns: string
      }
      profile_has_staff_permission: {
        Args: { p_permission: string; p_profile_id: string }
        Returns: boolean
      }
      request_p1_part_order: {
        Args: { p_part_id: string }
        Returns: Database["public"]["Tables"]["wo_parts"]["Row"]
      }
      reopen_work_order: {
        Args: {
          p_mode: string
          p_reason: string
          p_work_order_id: string
        }
        Returns: Json
      }
      resolve_location_sales_tax_rate: {
        Args: {
          p_address: string
          p_city: string | null
          p_county: string | null
          p_on_date: string
          p_postal_code: string | null
          p_state: string
        }
        Returns: Json
      }
      resubmit_rejected_contractor_invoice: {
        Args: {
          p_cme: string | null
          p_invoice_date: string | null
          p_invoice_id: string
          p_lines: Json
          p_pdf_storage_path?: string | null
          p_sales_tax: number | null
          p_service_date: string | null
          p_store_address: string | null
          p_terms: string | null
          p_total_override: number | null
        }
        Returns: Json
      }
      retract_contractor_invoice_rejection: {
        Args: { p_invoice_id: string }
        Returns: Json
      }
      review_contractor_invoice: {
        Args: {
          p_action: string
          p_invoice_id: string
          p_reason?: string | null
        }
        Returns: Json
      }
      review_contractor_invoices: {
        Args: {
          p_action: string
          p_invoice_ids: string[]
          p_reason?: string | null
        }
        Returns: Json
      }
      set_activity_contractor_attention: {
        Args: { p_activity_id: string; p_required: boolean }
        Returns: undefined
      }
      set_p1_part_order_status: {
        Args: { p_part_id: string; p_status: string }
        Returns: Database["public"]["Tables"]["wo_parts"]["Row"]
      }
      transfer_work_order_todo: {
        Args: { p_new_owner_id: string; p_work_order_id: string }
        Returns: Database["public"]["Tables"]["staff_work_order_todos"]["Row"]
      }
    }
    Enums: {
      capital_status:
        | "Pending approval"
        | "Approved - work authorized"
        | "Equipment ordered"
        | "Equipment received"
        | "Installation scheduled"
        | "Installed"
      fsm_functional_status:
        | "New"
        | "Dispatched"
        | "Work in Progress"
        | "Pending Capital Approval"
        | "Pending Capital Completion"
        | "Awaiting Parts"
        | "Completed"
        | "Cancelled"
      invoice_state:
        | "draft"
        | "submitted"
        | "approved"
        | "rejected"
        | "revised"
        | "paid"
      user_role: "manager" | "dispatcher" | "back_office" | "contractor"
      wo_priority: "p1" | "p2" | "p3" | "p4" | "p5"
      wo_status:
        | "unassigned"
        | "assigned"
        | "wip"
        | "parts"
        | "capital"
        | "pending_capital_completion"
        | "completed"
        | "pending_invoice"
        | "pending_approval"
        | "pending_payment"
        | "closed"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      capital_status: [
        "Pending approval",
        "Approved - work authorized",
        "Equipment ordered",
        "Equipment received",
        "Installation scheduled",
        "Installed",
      ],
      fsm_functional_status: [
        "New",
        "Dispatched",
        "Work in Progress",
        "Pending Capital Approval",
        "Pending Capital Completion",
        "Awaiting Parts",
        "Completed",
        "Cancelled",
      ],
      invoice_state: [
        "draft",
        "submitted",
        "approved",
        "rejected",
        "revised",
        "paid",
      ],
      user_role: ["manager", "dispatcher", "back_office", "contractor"],
      wo_priority: ["p1", "p2", "p3", "p4", "p5"],
      wo_status: [
        "unassigned",
        "assigned",
        "wip",
        "parts",
        "capital",
        "pending_capital_completion",
        "completed",
        "pending_invoice",
        "pending_approval",
        "pending_payment",
        "closed",
      ],
    },
  },
} as const
