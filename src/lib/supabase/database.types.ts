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
          created_at: string | null
          deleted_at: string | null
          entered_by_role: string
          event_data: Json
          event_key: string
          id: string
          is_staff_override: boolean
          override_for_contractor_id: string | null
          requires_7eleven_sync: boolean
          synced_to_7eleven_at: string | null
          synced_to_7eleven_by: string | null
          text: string
          type: string | null
          work_order_id: string
        }
        Insert: {
          author_id?: string | null
          author_name: string
          created_at?: string | null
          deleted_at?: string | null
          entered_by_role?: string
          event_data?: Json
          event_key?: string
          id?: string
          is_staff_override?: boolean
          override_for_contractor_id?: string | null
          requires_7eleven_sync?: boolean
          synced_to_7eleven_at?: string | null
          synced_to_7eleven_by?: string | null
          text: string
          type?: string | null
          work_order_id: string
        }
        Update: {
          author_id?: string | null
          author_name?: string
          created_at?: string | null
          deleted_at?: string | null
          entered_by_role?: string
          event_data?: Json
          event_key?: string
          id?: string
          is_staff_override?: boolean
          override_for_contractor_id?: string | null
          requires_7eleven_sync?: boolean
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
          tier: string | null
          updated_at: string | null
        }
        Insert: {
          contractor_id?: string | null
          created_at?: string | null
          id?: string
          is_active?: boolean | null
          name: string
          tier?: string | null
          updated_at?: string | null
        }
        Update: {
          contractor_id?: string | null
          created_at?: string | null
          id?: string
          is_active?: boolean | null
          name?: string
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
        ]
      }
      invoice_lines: {
        Row: {
          amount: number | null
          description: string | null
          id: string
          invoice_id: string
          position: number
          qty: number
          rate: number
          type: string
        }
        Insert: {
          amount?: number | null
          description?: string | null
          id?: string
          invoice_id: string
          position: number
          qty?: number
          rate?: number
          type: string
        }
        Update: {
          amount?: number | null
          description?: string | null
          id?: string
          invoice_id?: string
          position?: number
          qty?: number
          rate?: number
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
          sales_tax: number | null
          service_date: string | null
          state: Database["public"]["Enums"]["invoice_state"]
          store_address: string | null
          store_number: string | null
          subtotal: number | null
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
          sales_tax?: number | null
          service_date?: string | null
          state?: Database["public"]["Enums"]["invoice_state"]
          store_address?: string | null
          store_number?: string | null
          subtotal?: number | null
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
          sales_tax?: number | null
          service_date?: string | null
          state?: Database["public"]["Enums"]["invoice_state"]
          store_address?: string | null
          store_number?: string | null
          subtotal?: number | null
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
          contractor_tier: "direct" | "mr_freeze" | "contracted" | null
          created_at: string | null
          default_labor_rate: number | null
          default_parts_markup: number | null
          default_truck_rate: number | null
          dispatcher_id: string | null
          email: string
          id: string
          initials: string | null
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
          contractor_tier?: "direct" | "mr_freeze" | "contracted" | null
          created_at?: string | null
          default_labor_rate?: number | null
          default_parts_markup?: number | null
          default_truck_rate?: number | null
          dispatcher_id?: string | null
          email: string
          id: string
          initials?: string | null
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
          contractor_tier?: "direct" | "mr_freeze" | "contracted" | null
          created_at?: string | null
          default_labor_rate?: number | null
          default_parts_markup?: number | null
          default_truck_rate?: number | null
          dispatcher_id?: string | null
          email?: string
          id?: string
          initials?: string | null
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
      work_orders: {
        Row: {
          address: string | null
          afm_email: string | null
          afm_id: string | null
          afm_name: string | null
          asset_make: string | null
          asset_model: string | null
          asset_serial: string | null
          asset_year: number | null
          business_service: string | null
          capital_status: Database["public"]["Enums"]["capital_status"] | null
          capital_notes: string | null
          category: string | null
          city: string | null
          closed_at: string | null
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
          sub_category: string | null
          summary: string | null
          technician_on_job: string | null
          updated_at: string | null
        }
        Insert: {
          address?: string | null
          afm_email?: string | null
          afm_id?: string | null
          afm_name?: string | null
          asset_make?: string | null
          asset_model?: string | null
          asset_serial?: string | null
          asset_year?: number | null
          business_service?: string | null
          capital_status?: Database["public"]["Enums"]["capital_status"] | null
          capital_notes?: string | null
          category?: string | null
          city?: string | null
          closed_at?: string | null
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
          sub_category?: string | null
          summary?: string | null
          technician_on_job?: string | null
          updated_at?: string | null
        }
        Update: {
          address?: string | null
          afm_email?: string | null
          afm_id?: string | null
          afm_name?: string | null
          asset_make?: string | null
          asset_model?: string | null
          asset_serial?: string | null
          asset_year?: number | null
          business_service?: string | null
          capital_status?: Database["public"]["Enums"]["capital_status"] | null
          capital_notes?: string | null
          category?: string | null
          city?: string | null
          closed_at?: string | null
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
          sub_category?: string | null
          summary?: string | null
          technician_on_job?: string | null
          updated_at?: string | null
        }
        Relationships: [
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
      is_staff: { Args: never; Returns: boolean }
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
