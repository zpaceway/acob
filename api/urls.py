from django.urls import path

from . import views

urlpatterns = [
    path("instructions/", views.create_instruction, name="create-instruction"),
    path("instructions/next/", views.next_instruction, name="next-instruction"),
    path(
        "instructions/<int:instruction_id>/",
        views.instruction_detail,
        name="instruction-detail",
    ),
    path(
        "instructions/<int:instruction_id>/result/",
        views.complete_instruction,
        name="complete-instruction",
    ),
]
