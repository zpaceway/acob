from django.contrib import admin

from .models import Instruction, Reinstall


@admin.register(Instruction)
class InstructionAdmin(admin.ModelAdmin):  # ty: ignore[missing-type-argument]
    list_display = ("id", "action", "bid", "status", "created_at", "updated_at")
    list_filter = ("action", "status")
    search_fields = ("=id", "bid")
    readonly_fields = ("created_at", "updated_at")


@admin.register(Reinstall)
class ReinstallAdmin(admin.ModelAdmin):  # ty: ignore[missing-type-argument]
    list_display = ("id", "token", "requested_at")
    readonly_fields = ("token", "requested_at")
