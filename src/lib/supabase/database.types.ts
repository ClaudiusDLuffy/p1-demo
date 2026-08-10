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
          state: Database["public"]["Enums"]["invoice_state"]
          store_address: string | null
          store_number: string | null
          submission_key: string | null
          subtotal: number | null
          tax_rate: number | null
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
          state?: Database["public"]["Enums"]["invoice_state"]
          store_address?: string | null
          store_number?: string | null
          submission_key?: string | null
          subtotal?: number | null
          tax_rate?: number | null
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
          state?: Database["public"]["Enums"]["invoice_state"]
          store_address?: string | null
          store_number?: string | null
          submission_key?: string | null
          subtotal?: number | null
          tax_rate?: number | null
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
          store_state: string | null
          store_timezone: string | null
          sub_category: string | null
          summary: string | null
          technician_on_job: string | null
          technician_assigned_at: string | null
          technician_assigned_by: string | null
          updated_at: string | null
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
          store_state?: string | null
          store_timezone?: string | null
          sub_category?: string | null
          summary?: string | null
          technician_on_job?: string | null
          technician_assigned_at?: string | null
          technician_assigned_by?: string | null
          updated_at?: string | null
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
          store_state?: string | null
          store_timezone?: string | null
          sub_category?: string | null
          summary?: string | null
          technician_on_job?: string | null
          technician_assigned_at?: string | null
          technician_assigned_by?: string | null
          updated_at?: string | null
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
      contractor_account_id_for_profile: {
        Args: { p_profile_id: string }
        Returns: string | null
      }
      contractor_invoice_work_order_status: {
        Args: { p_work_order_id: string }
        Returns: Database["public"]["Enums"]["wo_status"] | null
      }
      correct_contractor_invoice_total: {
        Args: {
          p_invoice_id: string
          p_reason?: string | null
          p_total: number
        }
        Returns: Database["public"]["Tables"]["invoices"]["Row"]
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
      can_access_contractor_work_order: {
        Args: { p_work_order_id: string }
        Returns: boolean
      }
      can_manage_work_order_technician: {
        Args: { p_work_order_id: string }
        Returns: boolean
      }
      mark_staff_work_order_read: {
        Args: { p_read_through_at: string; p_work_order_id: string }
        Returns: Database["public"]["Tables"]["staff_work_order_notification_reads"]["Row"]
      }
      mark_staff_invoice_billed: {
        Args: {
          p_actor_id: string
          p_invoice_id: string
        }
        Returns: Json
      }
      move_work_order_straight_to_billing: {
        Args: { p_work_order_id: string }
        Returns: Database["public"]["Tables"]["work_orders"]["Row"]
      }
      is_invoice_controller: { Args: never; Returns: boolean }
      is_staff: { Args: never; Returns: boolean }
      next_contractor_invoice_num: { Args: never; Returns: string }
      next_staff_invoice_num: {
        Args: { p_actor_id: string }
        Returns: string
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
      set_activity_contractor_attention: {
        Args: { p_activity_id: string; p_required: boolean }
        Returns: undefined
      }
      transfer_work_order_todo: {
        Args: { p_new_owner_id: string; p_work_order_id: string }
        Returns: Database["public"]["Tables"]["staff_work_order_todos"]["Row"]
      }
    }
    Enums: {
      capital_status:
        | "Pending approval"
        | "Equipment ordered"
        | "Equipment received"
        | "Installation scheduled"
        | "Installed"
      fsm_functional_status:
        | "New"
        | "Dispatched"
        | "Work in Progress"
        | "Pending Capital Approval"
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
        "completed",
        "pending_invoice",
        "pending_approval",
        "pending_payment",
        "closed",
      ],
    },
  },
} as const
