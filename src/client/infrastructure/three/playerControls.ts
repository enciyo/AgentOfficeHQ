interface ModalElement {
  classList: { contains(token: string): boolean };
}

export const isModalOpen = (modal: ModalElement | null) => !!modal && !modal.classList.contains('hidden');
